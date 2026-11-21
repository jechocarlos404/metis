"""The plugin's scripts run, on the oldest Python they promise, and their copies agree.

Stdlib and pytest only, no `app` import: CI also runs this file alone under
Python 3.9 (`--noconftest`), the floor plugin/README.md gives for `python3`.
The seed format and its validator are kept in several copies by hand
("keep identical"); this is what holds them to it.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "plugin" / "skills"
VALIDATE = SKILLS / "metis-export" / "scripts" / "validate_seed.py"
LOADER = SKILLS / "metis-seed-instance" / "scripts" / "seed_instance.py"
HOOKS = ROOT / "plugin" / "hooks" / "metis_hooks.py"
JS_IMPORTER = ROOT / "frontend" / "src" / "pages" / "api" / "seed" / "import.js"
SCRIPTS = sorted(SKILLS.glob("*/scripts/*.py"))

VALID = {
    "format": "metis-seed/v1",
    "goals": [{"ref": "g1", "goal_type": "org", "title": "Riders climb more"}],
    "capabilities": [{"ref": "c1", "name": "Route Planning"}],
    "motivations": [{"goal_ref": "g1", "capability_ref": "c1"}],
    "features": [
        {"ref": "f1", "product_ref": "p1", "name": "Plan a route", "capability_refs": ["c1"]},
        {"ref": "f2", "product_ref": "p1", "name": "Share a route", "capability_refs": ["c1"]},
    ],
    "edges": [{"src_ref": "f2", "dst_ref": "f1", "kind": "DEPENDS_ON"}],
    # A feature names its product (product_ref); a product lists none.
    "products": [{"ref": "p1", "name": "Saddlebag"}],
}


#: Every key the format allows, on every kind of object. Each validator must
#: take it clean, which holds their key lists together.
EVERY_KEY = {
    "format": "metis-seed/v1",
    "source": {"name": "every key", "generated_by": "test"},
    "goals": [
        {"ref": "g1", "goal_type": "org", "parent_ref": None, "title": "Riders climb more",
         "description": "d", "success_criteria": "s", "priority": 1, "status": "pending"},
    ],
    "capabilities": [
        {"ref": "c1", "parent_ref": None, "name": "Route Planning", "slug": "route-planning",
         "description": "d", "maturity": "ga", "facets": {"area": "maps"}, "evidence_anchors": ["src/route.py"]},
        {"ref": "c2", "parent_ref": "c1", "name": "Elevation", "maturity": "beta"},
    ],
    "motivations": [{"goal_ref": "g1", "capability_ref": "c1"}],
    "features": [
        {"ref": "f1", "capability_refs": ["c1"], "unknown_capabilities": False,
         "capability_guesses": [{"capability_ref": "c2", "confidence": "high", "basis": "b"}],
         "product_ref": "p1", "name": "Plan a route", "description": "d", "facets": {"k": "v"},
         "status": "done", "priority": 1, "priority_rationale": "r"},
        {"ref": "f2", "capability_ref": "c1", "product_ref": "p1", "name": "Share a route"},
    ],
    "edges": [{"src_ref": "f2", "dst_ref": "f1", "kind": "DEPENDS_ON"}],
    "products": [
        {"ref": "p1", "goal_ref": "g1", "name": "Saddlebag", "summary": "s", "body": "b", "external": False,
         "bundle_refs": ["c2"], "decomposition": {"summary": "s", "epics": [
             {"title": "E", "acceptance_criteria": ["a"], "capability_ref": "c1", "stories": [
                 {"title": "S", "description": "d", "feature_ref": "f1", "tickets": [
                     {"title": "T", "description": "d", "technical_approach": "t", "acceptance_criteria": ["a"],
                      "affected_files": ["src/route.py"], "context_budget": "M"}]}]}]}},
    ],
    "technologies": [
        {"ref": "t1", "name": "Valhalla", "slug": "valhalla", "kind": "service", "layer": "api",
         "products": ["p1"], "satisfies": [
             {"capability_ref": "c1", "fit": "native"},
             {"capability_ref": "c2", "fit": "partial", "confidence": "low", "basis": "b"}]},
    ],
}


def _broken(**changes):
    doc = json.loads(json.dumps(VALID))
    doc.update(changes)
    return doc


#: One valid document and one per kind of mistake the validators catch.
DOCS = [
    VALID,
    EVERY_KEY,
    _broken(format="metis-seed/v2"),
    _broken(capabilities=[{"ref": "c1", "name": "A"}, {"ref": "c1", "name": "B"}]),
    _broken(features=[{"ref": "f1", "name": "Plan", "capability_refs": ["nope"]}]),
    _broken(features=[{"ref": "f1", "name": "Plan", "capability_refs": []}]),
    _broken(capabilities=[{"ref": "c1", "name": "Route Planning", "maturity": "shipped"}]),
    _broken(
        edges=[
            {"src_ref": "f1", "dst_ref": "f2", "kind": "DEPENDS_ON"},
            {"src_ref": "f2", "dst_ref": "f1", "kind": "DEPENDS_ON"},
        ]
    ),
    _broken(goals=[{"ref": "g1", "goal_type": "team", "title": "x"}]),
    # Misspelled keys: each is named, never dropped without a word.
    _broken(
        capabilites=[],
        capabilities=[{"ref": "c1", "name": "Route Planning", "maturty": "ga"}],
        features=[
            {"ref": "f1", "name": "Plan a route", "capability_refs": ["c1"], "stauts": "done"},
            {"ref": "f2", "name": "Share a route", "capability_refs": ["c1"],
             "capability_guesses": [], "notes": "x"},
        ],
        products=[{"ref": "p1", "name": "Saddlebag", "externl": True, "decomposition": {
            "epics": [{"title": "E", "stories": [{"title": "S", "tickets": [{"title": "T", "estimate": 3}]}]}],
        }}],
        technologies=[{"ref": "t1", "name": "Valhalla", "kind": "service",
                       "satisfies": [{"capability_ref": "c1", "fit": "native", "note": "x"}]}],
    ),
]


def test_every_key_the_format_has_is_taken():
    for path in (VALIDATE, LOADER):
        assert _load(path, path.stem).validate(EVERY_KEY) == [], path


def test_a_misspelled_key_is_named_with_where_it_is():
    assert _load(VALIDATE, "validate_seed").validate(DOCS[-1]) == [
        "the file: unknown key 'capabilites'",
        "capabilities[0] (c1): unknown key 'maturty'",
        "features[0] (f1): unknown key 'stauts'",
        "features[1] (f2): unknown key 'notes'",
        "products[0] (p1): unknown key 'externl'",
        "products[0] (p1).epics[0].stories[0].tickets[0]: unknown key 'estimate'",
        "technologies[0] (t1).satisfies[0]: unknown key 'note'",
    ]


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(*args, **kwargs):
    return subprocess.run(
        [sys.executable, "-I", *map(str, args)], capture_output=True, text=True,
        timeout=30, **kwargs
    )


def test_the_seed_format_copies_are_identical():
    copies = [
        ROOT / "backend" / "app" / "ontology" / "seed-format.md",
        SKILLS / "metis-export" / "references" / "seed-format.md",
        SKILLS / "metis-seed-instance" / "references" / "seed-format.md",
    ]
    texts = {str(p.relative_to(ROOT)): p.read_text() for p in copies}
    assert len(set(texts.values())) == 1, list(texts)


def _validator(path):
    """Everything from the constants through validate(), as both files mark it."""
    text = path.read_text()
    start = text.index("GOAL_TYPES = ")
    end = text.index("\n    return errors\n", text.index("def validate(doc):"))
    return text[start:end]


def test_the_two_python_validators_are_identical():
    assert _validator(VALIDATE) == _validator(LOADER)


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_every_script_starts(script):
    """--help imports the whole file, so a syntax or import the floor Python
    lacks fails here rather than in someone's session."""
    result = _run(script, "--help")
    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout


def test_validate_seed_accepts_a_good_file_and_names_what_is_wrong(tmp_path):
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    good.write_text(json.dumps(VALID))
    bad.write_text(json.dumps(DOCS[4]))
    result = _run(VALIDATE, good)
    assert result.returncode == 0, result.stderr
    assert "is valid: 1 goals, 1 capabilities, 1 motivations, 2 features, 1 edges" in result.stdout
    result = _run(VALIDATE, bad)
    assert result.returncode == 1
    assert "capability ref 'nope' does not match a capability" in result.stderr


def _unquoted(results):
    return [[re.sub("[\"']", "'", e).replace("', '", "','") for e in r] for r in results]


def test_every_validator_gives_the_same_errors():
    """Both Python copies and the desktop importer's JavaScript one."""
    expected = [_load(VALIDATE, "validate_seed").validate(d) for d in DOCS]
    assert expected[:2] == [[], []] and all(expected[2:]), expected
    assert [_load(LOADER, "seed_instance").validate(d) for d in DOCS] == expected
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; the JS validator is checked where it is")
    script = (
        f"import {{ validateSeed }} from {json.dumps(JS_IMPORTER.as_uri())};"
        "let s = ''; process.stdin.on('data', (c) => (s += c));"
        "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(validateSeed))));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "-e", script], input=json.dumps(DOCS),
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    # JS quotes a value as JSON ("c1", ["a","b"]), Python as repr ('c1', ['a', 'b']).
    assert _unquoted(json.loads(result.stdout)) == _unquoted(expected)


UNSEED = SKILLS / "metis-unseed" / "scripts" / "unseed_instance.py"
WORDS = ROOT / "frontend" / "src" / "lib" / "words.js"

#: The slug rule, which every copy must give exactly: accents folded (NFKD,
#: every combining mark dropped) before lowercasing, then lowercase kebab.
#: test_slugs checks the backend's own copy against the same list.
SLUG_VECTORS = [
    ("Résumé Parsing", "resume-parsing"),
    ("Café", "cafe"),
    ("Crème brûlée", "creme-brulee"),
    ("İstanbul", "istanbul"),
    # ß has no decomposition, so it goes like any other letter outside a-z.
    ("Straße", "stra-e"),
    ("🚀🎉", ""),
    ("Semantic Search", "semantic-search"),
    ("  PM Export — ticket delivery  ", "pm-export-ticket-delivery"),
    ("OAuth 2.1", "oauth-2-1"),
    ("Ｗｉｄｅ ﬁle", "wide-file"),
]


def test_every_slug_rule_copy_gives_the_same_slugs():
    """The hooks and each script keep their own copy (stdlib only, no
    backend); the app's copy is words.js, which every frontend caller imports."""
    expected = [slug for _, slug in SLUG_VECTORS]
    names = [name for name, _ in SLUG_VECTORS]
    for path in (HOOKS, VALIDATE, LOADER, UNSEED, SKILLS / "metis-fill-gaps" / "scripts" / "find_gaps.py"):
        assert [_load(path, path.stem).slugify(n) for n in names] == expected, path.name
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; the JS copy is checked where it is")
    script = (
        f"import {{ slugify }} from {json.dumps(WORDS.as_uri())};"
        "let s = ''; process.stdin.on('data', (c) => (s += c));"
        "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(slugify))));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "-e", script], input=json.dumps(names),
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == expected


#: The two 403 bodies the API sends, as the wire has them.
ROLE_403 = {"detail": "Requires editor or admin role"}
SURFACE_403 = {"detail": {"error": "human_action_required", "message": "A human action.", "href": "/tech"}}


@pytest.mark.parametrize("path", [LOADER, UNSEED], ids=lambda p: p.name)
def test_a_refused_write_says_who_can_make_it(path):
    """A viewer can't write in the app either, so it hears that an editor or
    admin can; a read-only token hears that a person signed in to the app
    can. Neither is told a script can never get a token that writes."""
    refused = _load(path, path.stem).refused
    with pytest.raises(SystemExit) as role:
        refused("POST", "/api/tech", 403, ROLE_403, "token")
    said = str(role.value)
    assert said.startswith("error: POST /api/tech returned 403 (Requires editor or admin role): ")
    assert "this account can't" in said and "an editor or admin" in said
    assert "Settings, Seed files" in said
    with pytest.raises(SystemExit) as surface:
        refused("POST", "/api/tech", 403, SURFACE_403, "token")
    said = str(surface.value)
    assert "this token can read but not" in said
    assert "a person signed in to the app as an editor or admin" in said
    for text in (str(role.value), str(surface.value), path.read_text()):
        assert "no script can get" not in text and "desktop session" not in text


class _FakeMetis(BaseHTTPRequestHandler):
    PRODUCTS = [
        {"id": "p1", "slug": "saddlebag", "name": "Saddlebag", "external": False,
         "seeded_at": None},
        {"id": "p2", "slug": "hanko", "name": "Hanko", "external": False},
    ]
    INVENTORY = [
        {"name": "Route Planning", "slug": "route-planning",
         "products": [{"id": "p1", "slug": "saddlebag", "name": "Saddlebag"},
                      {"id": "p2", "slug": "hanko", "name": "Hanko"}]},
    ]

    def do_GET(self):  # noqa: N802 — the stdlib's name
        body = {
            "/api/products": self.PRODUCTS,
            "/api/capabilities/inventory": self.INVENTORY,
            "/api/products/p1/coverage": {"total_features": 2},
        }.get(self.path)
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, *args):
        pass


@pytest.fixture
def metis():
    server = HTTPServer(("127.0.0.1", 0), _FakeMetis)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def _hook(name, event, api, data):
    env = {"PATH": os.environ["PATH"], "HOME": str(data), "METIS_API_URL": api,
           "CLAUDE_PLUGIN_DATA": str(data / "plugin")}
    result = _run(HOOKS, name, input=json.dumps(event), env=env)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout else None


def test_the_hooks_say_their_line_and_stay_silent_without_metis(tmp_path, metis):
    repo = tmp_path / "saddlebag"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "app.py").write_text("print('hi')\n")

    brief = _hook("session-start", {"cwd": str(repo)}, metis, tmp_path)
    context = brief["hookSpecificOutput"]["additionalContext"]
    assert "this repo is the product Saddlebag (saddlebag), matched by repo name." in context
    assert "2 feature(s), 1 capabilit(ies), 1 shared with other products." in context
    assert "- Route Planning -> Hanko" in context

    nudge = _hook("user-prompt", {"cwd": str(repo), "prompt": "add route planning"},
                  metis, tmp_path)
    assert "Route Planning (route-planning) already exists in Hanko" in (
        nudge["hookSpecificOutput"]["additionalContext"]
    )

    stop = {"cwd": str(repo), "session_id": "s1"}
    reminder = _hook("stop", stop, metis, tmp_path)
    assert reminder["systemMessage"].startswith("metis: Saddlebag has code changes.")
    assert _hook("stop", stop, metis, tmp_path) is None  # once per session

    closed = "http://127.0.0.1:9"
    for name, event in (("session-start", {"cwd": str(repo)}),
                        ("user-prompt", {"cwd": str(repo), "prompt": "x"}),
                        ("stop", {"cwd": str(repo), "session_id": "s2"})):
        assert _hook(name, event, closed, tmp_path / "cold") is None, name


def test_a_load_that_fails_partway_says_what_it_wrote_and_that_the_same_file_finishes_it(
    tmp_path, monkeypatch, capsys
):
    module = _load(LOADER, "seed_instance")
    made = []

    class Api(module.Api):
        """A fresh instance in memory: every list is empty, every write is
        made, except that a feature can't be created."""
        def request(self, method, path, payload=None):
            if method == "POST" and path == "/api/features":
                return 503, {"detail": "upstream down"}
            if method == "POST":
                made.append(path)
                return 201, {"id": f"id-{len(made)}", **(payload or {})}
            return 200, {"status": "ok"} if path == "/api/health" else []

    monkeypatch.setattr(module, "Api", Api)
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps(VALID))
    monkeypatch.setattr(sys, "argv", ["seed_instance.py", str(seed), "--base-url", "http://metis.test"])
    with pytest.raises(SystemExit) as stop:
        module.main()
    assert str(stop.value.code) == (
        "The load stopped partway. Before it stopped, it wrote: goals 1 created; capabilities 1 "
        "created; motivations 1 created; products 1 created. Those stay. Loading this file again is safe: it finds those by "
        "name and slug, and adds only the rest."
    )
    assert capsys.readouterr().err.startswith("error: POST /api/features for 'Plan a route' returned 503")


def _lookup_loader(n, failing=False):
    """The loader's dry run of a file adding n capabilities and one 120-character
    name, against an instance holding "Keyword search" whose coverage read keeps
    the backend's bounds (300 names a request, each at most 100 long)."""
    module = _load(LOADER, "seed_instance")
    asked = []

    class Api(module.Api):
        def request(self, method, path, payload=None):
            if path != "/api/capabilities/coverage":
                return 200, []
            names = [c for f in payload["features"] for c in f["capabilities"]]
            asked.append(len(names))
            if failing:
                return 503, {"detail": "upstream down"}
            if len(names) > 300 or any(len(c) > 100 for c in names):
                return 422, {"detail": "too many or too long"}
            needs = [{"name": c, "candidates": [{"name": "Keyword search"}] if "search" in c else []}
                     for c in names]
            return 200, {"features": [{"name": "seed file", "capabilities": needs}]}

    loader = module.Loader(Api("http://metis.test"), {}, dry_run=True)
    names = [f"Probe {i} search" for i in range(n)] + ["x" * 120]
    loader.list_added_capabilities(names)
    return loader, asked


def test_the_dry_run_looks_up_nearest_names_in_chunks_the_coverage_read_takes():
    loader, asked = _lookup_loader(650)
    assert asked == [300, 300, 50]
    assert loader.warnings == []
    for i in (0, 299, 300, 649):
        assert f'new capability "Probe {i} search"; nearest existing: "Keyword search"' in loader.notes
    assert f'new capability "{"x" * 120}"; not looked up for nearest names (over 100 characters)' in loader.notes


def test_a_nearest_name_lookup_that_fails_is_said():
    loader, _ = _lookup_loader(2, failing=True)
    assert loader.warnings == [
        "couldn't look up the nearest existing names for 2 new capabilities "
        "(\"Probe 0 search\" to \"Probe 1 search\"): the lookup returned 503: {'detail': 'upstream down'}"
    ]
    assert 'new capability "Probe 0 search"' in loader.notes


# ---- the unseed script against an instance in memory ----


def _unseeder(routes, doc, failing=()):
    """The unseed script's Unseeder over its own Api, whose requests are
    answered from `routes` (path -> body): a path not there is a 404, one in
    `failing` a 503. Returns the dry run's report as printed."""
    module = _load(UNSEED, "unseed_instance")

    class Api(module.Api):
        def request(self, method, path, payload=None):
            if path in failing:
                return 503, {"detail": "upstream down"}
            if method == "GET" and path in routes:
                return 200, routes[path]
            return 404, None

    return module.Unseeder(Api("http://metis.test"), doc, dry_run=True)


def _run_unseed(unseeder, capsys):
    for step in ("remove_motivations", "remove_edges", "remove_features", "remove_products",
                 "remove_technologies", "remove_capabilities", "remove_goals", "numbers_note"):
        getattr(unseeder, step)()
    unseeder.report()
    return capsys.readouterr().out


PROBE_SEED = {
    "format": "metis-seed/v1",
    "capabilities": [{"ref": "c", "name": "Probe Cap"}],
    "products": [{"ref": "p", "name": "Probe"}],
    "features": [{"ref": "f", "product_ref": "p", "name": "Probe feature", "capability_refs": ["c"]}],
    "technologies": [{"ref": "t", "name": "Qdrant", "kind": "service", "products": ["p"],
                      "satisfies": [{"capability_ref": "c", "fit": "native"}]}],
}
AT = "2026-11-20T10:00:00Z"


def _probe(**extra):
    """One product with one feature on one capability, a technology it uses
    that satisfies it, a guess on the feature, a capability added by hand and
    a plan: every kind the in-app removal tallies."""
    routes = {
        "/api/goals": [],
        "/api/capabilities": [{"id": "cap1", "slug": "probe-cap", "name": "Probe Cap", "parent_id": None}],
        "/api/features": [{"id": "f1", "product_id": "p1", "name": "Probe feature", "capability_ids": ["cap1"]}],
        "/api/features/edges": [],
        "/api/products": [{"id": "p1", "name": "Probe", "status": "draft"}],
        "/api/motivations": [],
        "/api/product-bundles": [{"product_id": "p1", "capability_id": "cap1"}],
        "/api/tech/satisfactions": [{"id": "s1", "tech_id": "t1", "capability_id": "cap1", "fit": "native"}],
        "/api/guesses": [{"id": "g1", "feature_id": "f1", "capability_id": "cap1", "confidence": "low"}],
        "/api/tech?limit=200&offset=0": {"rows": [{"id": "t1", "slug": "qdrant", "name": "Qdrant", "used_by": 1}], "total": 1},
        "/api/tech/qdrant": {"id": "t1", "name": "Qdrant", "encounters": [], "versions": [], "outgoing": [], "incoming": []},
        "/api/stacks/usage?product_id=p1": [{"product_id": "p1", "tech_id": "t1"}],
        "/api/tickets": [],
        "/api/products/p1/decompositions": [{"id": "pd1", "product_id": "p1", "version": 1, "status": "draft"}],
    }
    routes.update(extra)
    return routes


def test_the_removal_line_names_tickets_a_re_import_wont_restore(capsys):
    """The latest plan made ep1: tk1 is as it was made, tk2 moved on since
    and tk3 was added by hand, so a re-import brings back neither of those."""
    routes = _probe(**{
        "/api/products/p1/decompositions": [
            {"id": "pd2", "product_id": "p1", "version": 2, "status": "draft"},
            {"id": "pd1", "product_id": "p1", "version": 1, "status": "draft"},
        ],
        "/api/products/p1/epics": [{"id": "ep1", "product_id": "p1", "decomposition_id": "pd2", "title": "Plan epic", "stories": []}],
        "/api/tickets": [
            {"id": "tk1", "product_id": "p1", "epic_id": "ep1", "created_at": AT, "updated_at": AT},
            {"id": "tk2", "product_id": "p1", "epic_id": "ep1", "created_at": AT, "updated_at": "2026-11-21T09:00:00Z"},
            {"id": "tk3", "product_id": "p1", "epic_id": None, "created_at": AT, "updated_at": AT},
        ],
    })
    out = _run_unseed(_unseeder(routes, PROBE_SEED), capsys)
    line = next(l for l in out.splitlines() if l.startswith("  would delete product 'Probe'"))
    assert "3 ticket(s)" in line
    assert line.endswith(
        "importing this file again won't bring back 1 older plan document(s) "
        "and 2 ticket(s) as they are now (changed or added since its plan was written)"
    ), line


def test_the_summary_tallies_each_kind_as_the_in_app_removal_does(capsys):
    """What a delete takes with it is counted under its own kind too, as the
    in-app removal's counts do (unseed.js): a product's technology use, hand
    added capabilities and plan documents, a feature's guesses, a
    technology's links and guesses."""
    out = _run_unseed(_unseeder(_probe(), PROBE_SEED), capsys)
    summary = {l.split()[0]: l.split(None, 1)[1] for l in out.splitlines()
               if l.startswith("  ") and not l.startswith(("  would", "  note", "  kept", "  can't"))}
    assert summary == {
        "features": "1 would delete",
        "products": "1 would delete",
        "bundles": "1 would delete",
        "decompositions": "1 would delete",
        "technologies": "1 would delete",
        "tech_usage": "1 would delete",
        "satisfactions": "1 would delete",
        "guesses": "1 would delete",
        "capabilities": "1 would delete",
    }, out


def test_a_technology_list_that_fails_to_read_is_unreadable_not_empty(capsys):
    """Read as none, the technologies would match nothing and their links
    would be judged against an empty list."""
    unseeder = _unseeder(_probe(), PROBE_SEED, failing={"/api/tech?limit=200&offset=0"})
    assert unseeder.unreadable == ["technologies"]
    assert "can't tell" in _run_unseed(unseeder, capsys)
