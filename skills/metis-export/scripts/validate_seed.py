#!/usr/bin/env python3
"""Validate a metis-seed JSON file (format v1) without touching an instance.

Stdlib only. Runs the same structural checks as the loader in the metis repo
(.claude/skills/metis-seed-instance/scripts/seed_instance.py — keep the validate()
function in sync with the copy there): required fields, enum values, ref
resolution, parent forests, and acyclicity of the precedence graph
(DEPENDS_ON plus reversed BLOCKS).

Usage:
    python3 validate_seed.py metis-seed.json
"""

import argparse
import json
import sys

GOAL_TYPES = {"org", "product"}
WORK_STATUSES = {"pending", "in_progress", "done"}
MATURITIES = {"planned", "alpha", "beta", "ga", "deprecated", "retired"}
EDGE_KINDS = {"DEPENDS_ON", "BLOCKS", "RELATES_TO"}
CONTEXT_BUDGETS = {"S", "M", "L"}


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


def main():
    ap = argparse.ArgumentParser(description="Validate a metis-seed JSON file.")
    ap.add_argument("seed_file")
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

    tickets = sum(
        len(s.get("tickets") or [])
        for p in doc.get("products") or []
        for e in (p.get("decomposition") or {}).get("epics") or []
        for s in e.get("stories") or []
    )
    counts = ", ".join(
        f"{len(doc.get(c) or [])} {c}"
        for c in ("goals", "capabilities", "motivations", "features", "edges", "products")
    )
    print(f"{args.seed_file} is valid: {counts}, {tickets} tickets")


if __name__ == "__main__":
    main()
