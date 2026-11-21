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
        {"ref": "f1", "name": "Plan a route", "capability_refs": ["c1"]},
        {"ref": "f2", "name": "Share a route", "capability_refs": ["c1"]},
    ],
    "edges": [{"src_ref": "f2", "dst_ref": "f1", "kind": "DEPENDS_ON"}],
    "products": [{"ref": "p1", "name": "Saddlebag", "feature_refs": ["f1", "f2"]}],
}


def _broken(**changes):
    doc = json.loads(json.dumps(VALID))
    doc.update(changes)
    return doc


#: One valid document and one per kind of mistake the validators catch.
DOCS = [
    VALID,
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
    bad.write_text(json.dumps(DOCS[3]))
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
    assert expected[0] == [] and all(expected[1:]), expected
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
