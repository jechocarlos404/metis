#!/usr/bin/env python3
"""Seed a running metis instance from a metis-seed JSON file (format v1).

Stdlib only — no dependencies. Idempotent and add-only: existing entities are
matched (goals by type+title; capabilities, features, and products by name;
edges by src+dst+kind; motivations by pair) and reused rather than duplicated,
so re-running the same file is safe. Nothing is ever updated or deleted.

Usage:
    python3 seed_instance.py metis-seed.json [--base-url http://localhost:8000] [--dry-run]
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

GOAL_TYPES = {"org", "product"}
WORK_STATUSES = {"pending", "in_progress", "done"}
MATURITIES = {"planned", "alpha", "beta", "ga", "deprecated", "retired"}
EDGE_KINDS = {"DEPENDS_ON", "BLOCKS", "RELATES_TO"}
CONTEXT_BUDGETS = {"S", "M", "L"}

DRY_PREFIX = "dry-run:"


# ---------------------------------------------------------------------------
# Validation — keep in sync with skills/metis-export/scripts/validate_seed.py
# ---------------------------------------------------------------------------


def _check_priority(errors, where, item):
    p = item.get("priority")
    if p is not None and (not isinstance(p, int) or isinstance(p, bool) or not 1 <= p <= 5):
        errors.append(f"{where}: priority must be an integer 1-5")


def _check_status(errors, where, item):
    s = item.get("status")
    if s is not None and s not in WORK_STATUSES:
        errors.append(f"{where}: status must be one of {sorted(WORK_STATUSES)}")


def _check_facets(errors, where, item):
    facets = item.get("facets")
    if facets is None:
        return
    if not isinstance(facets, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in facets.items()
    ):
        errors.append(f"{where}: facets must be an object of string -> string")


def validate(doc):
    """Return a list of error strings; empty means the document is loadable."""
    errors = []

    if doc.get("format") != "metis-seed/v1":
        errors.append("'format' must be \"metis-seed/v1\"")

    def check_refs(collection):
        refs = set()
        for i, item in enumerate(doc.get(collection) or []):
            ref = item.get("ref")
            if not isinstance(ref, str) or not ref:
                errors.append(f"{collection}[{i}]: missing or non-string 'ref'")
            elif ref in refs:
                errors.append(f"{collection}: duplicate ref {ref!r}")
            else:
                refs.add(ref)
        return refs

    goal_refs = check_refs("goals")
    cap_refs = check_refs("capabilities")
    feat_refs = check_refs("features")
    check_refs("products")

    def check_parent_forest(collection, refs):
        parents = {}
        for item in doc.get(collection) or []:
            ref, parent = item.get("ref"), item.get("parent_ref")
            if parent is not None:
                if parent not in refs:
                    errors.append(f"{collection} {ref!r}: unknown parent_ref {parent!r}")
                elif parent == ref:
                    errors.append(f"{collection} {ref!r}: is its own parent")
                else:
                    parents[ref] = parent
        for start in parents:
            seen, node = set(), start
            while node in parents:
                if node in seen:
                    errors.append(f"{collection}: parent cycle involving {node!r}")
                    break
                seen.add(node)
                node = parents[node]

    check_parent_forest("goals", goal_refs)
    check_parent_forest("capabilities", cap_refs)

    for i, g in enumerate(doc.get("goals") or []):
        where = f"goals[{i}] ({g.get('ref')})"
        if g.get("goal_type") not in GOAL_TYPES:
            errors.append(f"{where}: goal_type must be one of {sorted(GOAL_TYPES)}")
        if not g.get("title"):
            errors.append(f"{where}: 'title' is required")
        _check_priority(errors, where, g)
        _check_status(errors, where, g)

    for i, c in enumerate(doc.get("capabilities") or []):
        where = f"capabilities[{i}] ({c.get('ref')})"
        if not c.get("name"):
            errors.append(f"{where}: 'name' is required")
        if c.get("maturity") is not None and c["maturity"] not in MATURITIES:
            errors.append(f"{where}: maturity must be one of {sorted(MATURITIES)}")
        _check_facets(errors, where, c)
        anchors = c.get("evidence_anchors")
        if anchors is not None and (
            not isinstance(anchors, list) or any(not isinstance(a, str) for a in anchors)
        ):
            errors.append(f"{where}: evidence_anchors must be a list of strings")

    seen_pairs = set()
    for i, m in enumerate(doc.get("motivations") or []):
        where = f"motivations[{i}]"
        if m.get("goal_ref") not in goal_refs:
            errors.append(f"{where}: unknown goal_ref {m.get('goal_ref')!r}")
        if m.get("capability_ref") not in cap_refs:
            errors.append(f"{where}: unknown capability_ref {m.get('capability_ref')!r}")
        pair = (m.get("goal_ref"), m.get("capability_ref"))
        if pair in seen_pairs:
            errors.append(f"{where}: duplicate motivation {pair}")
        seen_pairs.add(pair)

    for i, f in enumerate(doc.get("features") or []):
        where = f"features[{i}] ({f.get('ref')})"
        if not f.get("name"):
            errors.append(f"{where}: 'name' is required")
        if f.get("capability_ref") not in cap_refs:
            errors.append(
                f"{where}: capability_ref {f.get('capability_ref')!r} does not match a capability"
            )
        _check_priority(errors, where, f)
        _check_status(errors, where, f)
        _check_facets(errors, where, f)

    seen_edges = set()
    precedence = {}  # feature ref -> set of feature refs it depends on
    for i, e in enumerate(doc.get("edges") or []):
        where = f"edges[{i}]"
        src, dst = e.get("src_ref"), e.get("dst_ref")
        kind = e.get("kind", "DEPENDS_ON")
        if src not in feat_refs:
            errors.append(f"{where}: unknown src_ref {src!r}")
            continue
        if dst not in feat_refs:
            errors.append(f"{where}: unknown dst_ref {dst!r}")
            continue
        if kind not in EDGE_KINDS:
            errors.append(f"{where}: kind must be one of {sorted(EDGE_KINDS)}")
            continue
        if src == dst:
            errors.append(f"{where}: self-loop on {src!r}")
            continue
        key = (src, dst, kind)
        if key in seen_edges:
            errors.append(f"{where}: duplicate edge {key}")
        seen_edges.add(key)
        if kind == "DEPENDS_ON":
            precedence.setdefault(src, set()).add(dst)
        elif kind == "BLOCKS":
            precedence.setdefault(dst, set()).add(src)

    # The precedence graph (DEPENDS_ON plus reversed BLOCKS) must be acyclic —
    # metis rejects cycle-closing edges at write time, so catch it here.
    state, cycle_found = {}, []

    def dfs(node, path):
        state[node] = "in"
        path.append(node)
        for nxt in sorted(precedence.get(node, ())):
            if cycle_found:
                return
            if state.get(nxt) == "in":
                cycle = path[path.index(nxt):] + [nxt]
                errors.append("edges: precedence cycle: " + " -> ".join(cycle))
                cycle_found.append(True)
                return
            if state.get(nxt) is None:
                dfs(nxt, path)
        path.pop()
        state[node] = "done"

    for ref in sorted(precedence):
        if state.get(ref) is None and not cycle_found:
            dfs(ref, [])

    for i, p in enumerate(doc.get("products") or []):
        where = f"products[{i}] ({p.get('ref')})"
        if not p.get("name"):
            errors.append(f"{where}: 'name' is required")
        if p.get("goal_ref") is not None and p["goal_ref"] not in goal_refs:
            errors.append(f"{where}: unknown goal_ref {p['goal_ref']!r}")
        decomp = p.get("decomposition")
        if decomp is None:
            continue
        for j, epic in enumerate(decomp.get("epics") or []):
            ewhere = f"{where}.epics[{j}]"
            if not epic.get("title"):
                errors.append(f"{ewhere}: 'title' is required")
            if epic.get("capability_ref") is not None and epic["capability_ref"] not in cap_refs:
                errors.append(f"{ewhere}: unknown capability_ref {epic['capability_ref']!r}")
            for k, story in enumerate(epic.get("stories") or []):
                swhere = f"{ewhere}.stories[{k}]"
                if not story.get("title"):
                    errors.append(f"{swhere}: 'title' is required")
                if story.get("feature_ref") is not None and story["feature_ref"] not in feat_refs:
                    errors.append(f"{swhere}: unknown feature_ref {story['feature_ref']!r}")
                for t, ticket in enumerate(story.get("tickets") or []):
                    twhere = f"{swhere}.tickets[{t}]"
                    if not ticket.get("title"):
                        errors.append(f"{twhere}: 'title' is required")
                    cb = ticket.get("context_budget")
                    if cb is not None and cb not in CONTEXT_BUDGETS:
                        errors.append(
                            f"{twhere}: context_budget must be one of {sorted(CONTEXT_BUDGETS)}"
                        )
                    files = ticket.get("affected_files")
                    if files is not None and (
                        not isinstance(files, list) or any(not isinstance(a, str) for a in files)
                    ):
                        errors.append(f"{twhere}: affected_files must be a list of strings")

    return errors


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def prune(payload):
    return {k: v for k, v in payload.items() if v is not None}


def parents_first(items):
    """Yield items so every parent_ref is yielded before its children."""
    done, remaining = set(), list(items)
    while remaining:
        progressed = False
        for item in list(remaining):
            parent = item.get("parent_ref")
            if parent is None or parent in done:
                done.add(item["ref"])
                remaining.remove(item)
                progressed = True
                yield item
        if not progressed:  # unreachable after validation; guard against hangs
            raise RuntimeError("unresolvable parent_ref ordering")


class Api:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")

    def request(self, method, path, payload=None):
        url = f"{self.base}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                return resp.status, json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            try:
                body = json.loads(body)
            except ValueError:
                pass
            return e.code, body
        except urllib.error.URLError as e:
            sys.exit(
                f"error: cannot reach {url}: {e.reason}\n"
                "Is the instance up? From the metis repo: docker compose up -d (API on :8000)"
            )

    def get(self, path):
        status, body = self.request("GET", path)
        if status != 200:
            sys.exit(f"error: GET {path} returned {status}: {body}")
        return body

    def post(self, path, payload):
        return self.request("POST", path, payload)


class Loader:
    def __init__(self, api, doc, dry_run):
        self.api = api
        self.doc = doc
        self.dry_run = dry_run
        self.counts = {}  # (collection, action) -> int
        self.notes = []  # expected skips (idempotent re-runs) — informational
        self.warnings = []  # seed content that could not be applied — exit 2
        self.goal_ids = {}
        self.cap_ids = {}
        self.feat_ids = {}

    def note(self, collection, action):
        self.counts[(collection, action)] = self.counts.get((collection, action), 0) + 1

    def create(self, collection, path, payload, label):
        if self.dry_run:
            self.note(collection, "would create")
            return f"{DRY_PREFIX}{collection}:{label}"
        status, body = self.api.post(path, prune(payload))
        if status != 201:
            sys.exit(f"error: POST {path} for {label!r} returned {status}: {body}")
        self.note(collection, "created")
        return body["id"]

    def load_goals(self):
        existing = {(g["goal_type"], g["title"]): g["id"] for g in self.api.get("/api/goals")}
        for g in parents_first(self.doc.get("goals") or []):
            key = (g["goal_type"], g["title"])
            if key in existing:
                self.goal_ids[g["ref"]] = existing[key]
                self.note("goals", "reused")
                continue
            self.goal_ids[g["ref"]] = self.create(
                "goals",
                "/api/goals",
                {
                    "goal_type": g["goal_type"],
                    "parent_goal_id": self.goal_ids.get(g.get("parent_ref")),
                    "title": g["title"],
                    "description": g.get("description"),
                    "success_criteria": g.get("success_criteria"),
                    "priority": g.get("priority"),
                    "status": g.get("status"),
                },
                g["title"],
            )

    def load_capabilities(self):
        existing = {c["name"]: c["id"] for c in self.api.get("/api/capabilities")}
        for c in parents_first(self.doc.get("capabilities") or []):
            if c["name"] in existing:
                self.cap_ids[c["ref"]] = existing[c["name"]]
                self.note("capabilities", "reused")
                continue
            self.cap_ids[c["ref"]] = self.create(
                "capabilities",
                "/api/capabilities",
                {
                    "parent_id": self.cap_ids.get(c.get("parent_ref")),
                    "name": c["name"],
                    "description": c.get("description"),
                    "maturity": c.get("maturity"),
                    "facets": c.get("facets"),
                    "evidence_anchors": c.get("evidence_anchors"),
                },
                c["name"],
            )

    def load_motivations(self):
        by_cap = {}
        for m in self.doc.get("motivations") or []:
            by_cap.setdefault(m["capability_ref"], []).append(m["goal_ref"])
        for cap_ref, goal_refs in sorted(by_cap.items()):
            cap_id = self.cap_ids[cap_ref]
            existing = set()
            if not str(cap_id).startswith(DRY_PREFIX):
                existing = {
                    g["id"] for g in self.api.get(f"/api/capabilities/{cap_id}/motivations")
                }
            for goal_ref in goal_refs:
                goal_id = self.goal_ids[goal_ref]
                if goal_id in existing:
                    self.note("motivations", "reused")
                elif self.dry_run:
                    self.note("motivations", "would create")
                else:
                    status, body = self.api.post(
                        f"/api/capabilities/{cap_id}/motivations", {"goal_id": goal_id}
                    )
                    if status != 201:
                        sys.exit(
                            f"error: motivation {goal_ref} -> {cap_ref} "
                            f"returned {status}: {body}"
                        )
                    self.note("motivations", "created")

    def load_features(self):
        existing = {f["name"]: f["id"] for f in self.api.get("/api/features")}
        for f in self.doc.get("features") or []:
            if f["name"] in existing:
                self.feat_ids[f["ref"]] = existing[f["name"]]
                self.note("features", "reused")
                continue
            self.feat_ids[f["ref"]] = self.create(
                "features",
                "/api/features",
                {
                    "capability_id": self.cap_ids[f["capability_ref"]],
                    "name": f["name"],
                    "description": f.get("description"),
                    "facets": f.get("facets"),
                    "status": f.get("status"),
                    "priority": f.get("priority"),
                    "priority_rationale": f.get("priority_rationale"),
                },
                f["name"],
            )

    def load_edges(self):
        existing = {
            (e["src_id"], e["dst_id"], e["kind"]) for e in self.api.get("/api/features/edges")
        }
        for e in self.doc.get("edges") or []:
            kind = e.get("kind", "DEPENDS_ON")
            src, dst = self.feat_ids[e["src_ref"]], self.feat_ids[e["dst_ref"]]
            label = f"{e['src_ref']} -{kind}-> {e['dst_ref']}"
            if (src, dst, kind) in existing:
                self.note("edges", "reused")
                continue
            if self.dry_run:
                self.note("edges", "would create")
                continue
            status, body = self.api.post(
                "/api/features/edges", {"src_id": src, "dst_id": dst, "kind": kind}
            )
            if status == 201:
                self.note("edges", "created")
            else:
                # Most likely a cycle-closing precedence edge, rejected by the
                # API against edges already in the instance. Skip and report.
                self.warnings.append(f"edge {label} rejected ({status}): {body}")
                self.note("edges", "rejected")

    def load_products(self):
        existing = {p["name"]: p["id"] for p in self.api.get("/api/products")}
        for p in self.doc.get("products") or []:
            pid = existing.get(p["name"])
            if pid is not None:
                self.note("products", "reused")
            else:
                pid = self.create(
                    "products",
                    "/api/products",
                    {
                        "goal_id": self.goal_ids.get(p.get("goal_ref")),
                        "name": p["name"],
                        "summary": p.get("summary"),
                        "body": p.get("body"),
                    },
                    p["name"],
                )
            decomp = p.get("decomposition")
            if decomp is None:
                continue
            if str(pid).startswith(DRY_PREFIX):
                self.note("decompositions", "would create")
                continue
            if self.api.get(f"/api/products/{pid}/decompositions"):
                self.notes.append(
                    f"product {p['name']!r} already has a PRD; left as-is "
                    "(the seeder never stacks a second decomposition)"
                )
                self.note("decompositions", "skipped")
                continue
            if self.dry_run:
                self.note("decompositions", "would create")
                continue
            status, body = self.api.post(
                f"/api/products/{pid}/decompositions",
                {"document": self.build_prd(decomp), "created_by": "metis-seed-instance"},
            )
            if status != 201:
                sys.exit(
                    f"error: decomposition for {p['name']!r} returned {status}: {body}"
                )
            self.note("decompositions", "created")

    def build_prd(self, decomp):
        def ticket(t):
            return prune(
                {
                    "title": t["title"],
                    "description": t.get("description"),
                    "technical_approach": t.get("technical_approach"),
                    "acceptance_criteria": t.get("acceptance_criteria"),
                    "affected_files": t.get("affected_files"),
                    "context_budget": t.get("context_budget"),
                }
            )

        def story(s):
            return prune(
                {
                    "title": s["title"],
                    "description": s.get("description"),
                    "feature_id": self.feat_ids.get(s.get("feature_ref")),
                    "tickets": [ticket(t) for t in s.get("tickets") or []],
                }
            )

        def epic(e):
            return prune(
                {
                    "title": e["title"],
                    "acceptance_criteria": e.get("acceptance_criteria"),
                    "capability_id": self.cap_ids.get(e.get("capability_ref")),
                    "stories": [story(s) for s in e.get("stories") or []],
                }
            )

        return prune(
            {
                "summary": decomp.get("summary"),
                "epics": [epic(e) for e in decomp.get("epics") or []],
            }
        )

    def report(self):
        order = [
            "goals",
            "capabilities",
            "motivations",
            "features",
            "edges",
            "products",
            "decompositions",
        ]
        for collection in order:
            actions = {a: n for (c, a), n in self.counts.items() if c == collection}
            if actions:
                detail = ", ".join(f"{n} {a}" for a, n in sorted(actions.items()))
                print(f"  {collection:16} {detail}")
        for n in self.notes:
            print(f"  note: {n}")
        for w in self.warnings:
            print(f"  warning: {w}")


def main():
    ap = argparse.ArgumentParser(
        description="Seed a running metis instance from a metis-seed JSON file."
    )
    ap.add_argument("seed_file")
    ap.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="metis API base URL (default: %(default)s)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and diff against the instance without writing anything",
    )
    args = ap.parse_args()

    try:
        with open(args.seed_file) as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit(f"error: cannot read {args.seed_file}: {e}")

    errors = validate(doc)
    if errors:
        print(f"{args.seed_file} failed validation:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    api = Api(args.base_url)
    status, _ = api.request("GET", "/api/health")
    if status != 200:
        sys.exit(f"error: {args.base_url}/api/health returned {status} — is the instance up?")

    loader = Loader(api, doc, args.dry_run)
    loader.load_goals()
    loader.load_capabilities()
    loader.load_motivations()
    loader.load_features()
    loader.load_edges()
    loader.load_products()

    print(("dry run — nothing written" if args.dry_run else "seed complete") + ":")
    loader.report()
    if loader.warnings and not args.dry_run:
        sys.exit(2)


if __name__ == "__main__":
    main()
