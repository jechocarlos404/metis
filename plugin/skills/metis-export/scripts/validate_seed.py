#!/usr/bin/env python3
"""Validate a metis-seed JSON file (format v1) without touching an instance.

Stdlib only. Runs the same structural checks as the loader in the metis
plugin (../../metis-seed-instance/scripts/seed_instance.py, next to this skill;
keep everything from the constants through validate() identical to the copy
there): required fields, enum values, ref resolution, guesses, technologies,
parent forests, and acyclicity of the precedence graph (DEPENDS_ON plus
reversed BLOCKS).

Usage:
    python3 validate_seed.py metis-seed.json
"""

import argparse
import json
import re
import sys
import unicodedata

GOAL_TYPES = {"org", "product"}
WORK_STATUSES = {"pending", "in_progress", "done"}
MATURITIES = {"planned", "alpha", "beta", "ga", "deprecated", "retired"}
EDGE_KINDS = {"DEPENDS_ON", "BLOCKS", "RELATES_TO"}
CONTEXT_BUDGETS = {"S", "M", "L"}
CONFIDENCES = {"low", "medium", "high"}
TECH_KINDS = {"language", "framework", "library", "runtime", "service", "model", "protocol"}
TECH_LAYERS = {"data", "api", "web", "agent", "infra", "ops"}
TECH_FITS = {"native", "partial", "workaround"}


def slugify(value):
    """The backend's slug rule: accents folded ("Café" is "Cafe"), then
    lowercase kebab, '' when nothing survives."""
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.category(c).startswith("M")
    )
    return re.sub(r"[^a-z0-9]+", "-", folded.strip().lower()).strip("-")


def tech_slug(tech):
    """A technology's identity: its explicit slug, else one derived from its name."""
    if tech.get("slug") is not None:
        return tech["slug"]
    return slugify(tech["name"]) if isinstance(tech.get("name"), str) else ""


# A capability's identity, the same rule: "Keyword search" is "Keyword Search".
cap_slug = tech_slug


def _check_guess(errors, where, item):
    if item.get("confidence") not in CONFIDENCES:
        errors.append(f"{where}: confidence must be one of {sorted(CONFIDENCES)}")
    if item.get("basis") is not None and not isinstance(item["basis"], str):
        errors.append(f"{where}: basis must be a string")


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


def feature_capability_refs(feature):
    """Every capability ref a feature REALIZES. `capability_refs` (list) is
    current; a legacy single `capability_ref` reads as a one-element list."""
    refs = feature.get("capability_refs")
    if refs is None and feature.get("capability_ref") is not None:
        refs = [feature["capability_ref"]]
    if refs is None and feature.get("unknown_capabilities") is True:
        refs = []  # declared unknown: none named yet
    return refs


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
    prod_refs = check_refs("products")

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

    seen_cap_slugs = set()
    for i, c in enumerate(doc.get("capabilities") or []):
        where = f"capabilities[{i}] ({c.get('ref')})"
        if not c.get("name"):
            errors.append(f"{where}: 'name' is required")
        slug = cap_slug(c)
        if not isinstance(slug, str) or not slug:
            errors.append(f"{where}: slug must be a non-empty string "
                          "(give one when the name yields none)")
        elif slug in seen_cap_slugs:
            errors.append(f"{where}: duplicate capability slug {slug!r}")
        else:
            seen_cap_slugs.add(slug)
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
        refs = feature_capability_refs(f)
        unknown = f.get("unknown_capabilities", False)
        if not isinstance(unknown, bool):
            errors.append(f"{where}: unknown_capabilities must be true or false")
        if not isinstance(refs, list) or (not refs and unknown is not True):
            errors.append(f"{where}: capability_refs must be a non-empty list of capability refs "
                          "(or set unknown_capabilities: true)")
        else:
            for ref in refs:
                if ref not in cap_refs:
                    errors.append(f"{where}: capability ref {ref!r} does not match a capability")
            if len(set(map(str, refs))) != len(refs):
                errors.append(f"{where}: capability_refs lists a capability twice")
        guesses = f.get("capability_guesses")
        if guesses is not None and not isinstance(guesses, list):
            errors.append(f"{where}: capability_guesses must be a list")
        elif guesses:
            confirmed = set(map(str, refs)) if isinstance(refs, list) else set()
            guessed = set()
            for j, g in enumerate(guesses):
                gwhere = f"{where}.capability_guesses[{j}]"
                if not isinstance(g, dict):
                    errors.append(f"{gwhere}: must be an object")
                    continue
                ref = g.get("capability_ref")
                if not isinstance(ref, str) or ref not in cap_refs:
                    errors.append(f"{gwhere}: capability_ref {ref!r} does not match a capability")
                elif ref in confirmed:
                    errors.append(f"{gwhere}: {ref!r} is also in capability_refs "
                                  "(a link is confirmed or guessed, not both)")
                elif ref in guessed:
                    errors.append(f"{gwhere}: {ref!r} is guessed twice")
                guessed.add(ref)
                _check_guess(errors, gwhere, g)
        if f.get("product_ref") is not None and f["product_ref"] not in prod_refs:
            errors.append(f"{where}: unknown product_ref {f['product_ref']!r}")
        _check_priority(errors, where, f)
        _check_status(errors, where, f)
        _check_facets(errors, where, f)

    check_refs("technologies")
    seen_slugs = set()
    for i, t in enumerate(doc.get("technologies") or []):
        where = f"technologies[{i}] ({t.get('ref')})"
        if not isinstance(t.get("name"), str) or not t["name"]:
            errors.append(f"{where}: 'name' is required")
        slug = tech_slug(t)
        if not isinstance(slug, str) or not slug:
            errors.append(f"{where}: slug must be a non-empty string "
                          "(give one when the name yields none)")
        elif slug in seen_slugs:
            errors.append(f"{where}: duplicate technology slug {slug!r}")
        else:
            seen_slugs.add(slug)
        if t.get("kind") not in TECH_KINDS:
            errors.append(f"{where}: kind must be one of {sorted(TECH_KINDS)}")
        if t.get("layer") is not None and t["layer"] not in TECH_LAYERS:
            errors.append(f"{where}: layer must be one of {sorted(TECH_LAYERS)}")
        products = t.get("products")
        if products is not None and (
            not isinstance(products, list)
            or any(not isinstance(ref, str) or ref not in prod_refs for ref in products)
        ):
            errors.append(f"{where}: products must be product refs")
        satisfies = t.get("satisfies")
        if satisfies is not None and not isinstance(satisfies, list):
            errors.append(f"{where}: satisfies must be a list")
            continue
        linked = set()
        for j, s in enumerate(satisfies or []):
            swhere = f"{where}.satisfies[{j}]"
            if not isinstance(s, dict):
                errors.append(f"{swhere}: must be an object")
                continue
            ref = s.get("capability_ref")
            if not isinstance(ref, str) or ref not in cap_refs:
                errors.append(f"{swhere}: capability_ref {ref!r} does not match a capability")
            elif ref in linked:
                errors.append(f"{swhere}: {ref!r} is listed twice")
            linked.add(ref)
            if s.get("confidence") is None:  # confirmed: observed in code
                if s.get("fit") not in TECH_FITS:
                    errors.append(f"{swhere}: fit must be one of {sorted(TECH_FITS)}")
                if s.get("basis") is not None and not isinstance(s["basis"], str):
                    errors.append(f"{swhere}: basis must be a string")
            else:  # a guess
                _check_guess(errors, swhere, s)
                if s.get("fit") is not None and s["fit"] not in TECH_FITS:
                    errors.append(f"{swhere}: fit must be one of {sorted(TECH_FITS)}")

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
        if not isinstance(p.get("external", False), bool):
            errors.append(f"{where}: external must be true or false")
        bundle_refs = p.get("bundle_refs")
        if bundle_refs is not None and (
            not isinstance(bundle_refs, list)
            or any(not isinstance(ref, str) or ref not in cap_refs for ref in bundle_refs)
        ):
            errors.append(f"{where}: bundle_refs must be capability refs")
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
        for c in (
            "goals", "capabilities", "motivations", "features", "edges", "products",
            "technologies",
        )
    )
    guesses = sum(len(f.get("capability_guesses") or []) for f in doc.get("features") or []) + sum(
        1
        for t in doc.get("technologies") or []
        for s in t.get("satisfies") or []
        if s.get("confidence") is not None
    )
    print(f"{args.seed_file} is valid: {counts}, {tickets} tickets, {guesses} guesses")


if __name__ == "__main__":
    main()
