"""Envelope → text.

Tools return text, not JSON. An agent quotes text back to a user; it
paraphrases JSON, and paraphrase is where the vocabulary drifts — "partial
support" for `workaround`, "approved" for `standard`. Once that happens the
transcripts stop being comparable with the screen and the log.

Four rules, all inherited from the API spec:

- **Numbers lead.** The first line is the count.
- **Enum values verbatim.** Nothing here title-cases or prettifies.
- **Same rows, same order.** The envelope arrives ordered; these functions
  never sort. A surface-specific sort is a surface-specific answer.
- **`Open: <href>` is the last line, always.** An agent's final move is handing
  a human the screen it reasoned from.

`as_of` is printed on answers whose truth expires. An agent quoting a stale
exposure number is worse than one that says it does not know.
"""

from typing import Any
from urllib.parse import quote

#: Column widths chosen so the common case lines up without padding logic
#: leaking into every function.
def _table(rows: list[list[str]]) -> list[str]:
    if not rows:
        return []
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    return [
        "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        for row in rows
    ]


def _tail(envelope: dict, lines: list[str], *, stamp: bool = False) -> str:
    for entry in envelope.get("unresolved", []):
        blocked = entry.get("blocked_by") or []
        suffix = f" [{', '.join(blocked)}]" if blocked else ""
        lines.append(f"Unresolved — {entry['subject']}: {entry['reason']}{suffix}")
    if stamp:
        lines.append(f"as_of {envelope['as_of']}")
    lines.append(f"Open: {envelope['href']}")
    return "\n".join(lines)


def capability_supply(envelope: dict) -> str:
    rows = envelope["answer"]
    slug = envelope["subject"]["slug"]
    lines = [f"{len(rows)} offer(s) for {slug}.", ""]
    lines += _table(
        [
            [
                r["tech"],
                r["fit"],
                r["stance"] or "(no stance)",
                f"ops {r['cost'].get('ops_burden', '?')}",
                "← bound in " + ", ".join(r["bound_in"]) if r["bound_in"] else "",
            ]
            for r in rows
        ]
    )
    realizations = envelope.get("realizations") or []
    if realizations:
        lines += ["", f"Build side — {len(realizations)} feature(s) realize it:"]
        lines += _table(
            [
                [f["feature"], f["status"], f"{f['tickets']} ticket(s)", f["product"] or ""]
                for f in realizations
            ]
        )
    if rows:
        lines.append("")
    return _tail(envelope, lines)


def tech_blast_radius(envelope: dict) -> str:
    rows = envelope["answer"]
    slug = envelope["subject"]["slug"]
    breaks = sum(1 for r in rows if r["required"])
    off = sum(1 for r in rows if r["off_stack"])
    lines = [
        f"{len(rows)} product(s) use {slug} — {breaks} required, {off} off_stack.",
        "",
    ]
    lines += _table(
        [
            [
                r["product"],
                r["layer"] or "—",
                r["role"] or "—",
                "required" if r["required"] else "optional",
                "off_stack" if r["off_stack"] else "",
            ]
            for r in rows
        ]
    )
    # An agent asking this is mid-decision, so the obvious next fact rides along.
    alternatives = envelope.get("alternatives") or []
    if alternatives:
        lines += ["", f"{len(alternatives)} alternative(s) for the same capability:"]
        lines += _table(
            [[a["tech"], a["fit"], a["stance"] or "(no stance)"] for a in alternatives]
        )
    lines.append("")
    return _tail(envelope, lines)


def tech_exposure(envelope: dict) -> str:
    rows = envelope["answer"]
    at_risk = sum(r["required_slots"] for r in rows)
    lines = [
        f"{len(rows)} exposed technolog(ies), {at_risk} required slot(s) affected.",
        "",
    ]
    lines += _table(
        [
            [
                r["tech"],
                r["version"] or "—",
                r["reason"],
                f"{r['products']} product(s)",
                f"{r['required_slots']} required slot(s)",
            ]
            for r in rows
        ]
    )
    lines.append("")
    # Exposure is the answer most likely to be quoted after it stops being true.
    return _tail(envelope, lines, stamp=True)


def stack_redundancy(envelope: dict) -> str:
    rows = envelope["answer"]
    lines = [
        f"{len(rows)} capabilit(ies) answered more than once in "
        f"{envelope['subject']['slug']}.",
        "",
    ]
    lines += _table(
        [[r["capability"], r["layer"] or "—", ", ".join(r["competing"])] for r in rows]
    )
    if rows:
        lines += ["", "Flagged, not resolved — two answers can be a deliberate decision."]
    return _tail(envelope, lines)


def tech_encounters(envelope: dict) -> str:
    rows = envelope["answer"]
    slug = envelope["subject"]["slug"]
    lines = [f"{len(rows)} person(s) have touched {slug}.", ""]
    lines += _table(
        [[r["person"], r["depth"], r["last_at"], r["on_product"] or ""] for r in rows]
    )
    if rows:
        # shipped beats touched beats evaluated, and the list already says so.
        lines += ["", f"Ask {rows[0]['person']} first ({rows[0]['depth']})."]
    return _tail(envelope, lines)


def stack_recommend(envelope: dict) -> str:
    rows = envelope["answer"]
    pruned = envelope.get("pruned") or []
    unresolved = envelope.get("unresolved") or []
    lines = [
        f"Bound {len(rows)} slot(s) for {envelope['subject']['slug']}. "
        f"{len(unresolved)} slot(s) unresolved.",
        "",
    ]
    lines += _table([[r["slot"], r["tech"], r["fit"], r["stance"] or "(no stance)"] for r in rows])
    for row in rows:
        lines.append(f"  {row['slot']}: {row['why']}")
    if pruned:
        lines += ["", f"{len(pruned)} offer(s) pruned by a constraint:"]
        lines += _table(
            [[p["slot"], p["tech"], ", ".join(p["blocked_by"])] for p in pruned]
        )
    lines.append("")
    return _tail(envelope, lines)


def tech_search(page: dict, query: str | None) -> str:
    """The navigation tool. Not an envelope — the catalog endpoint predates it
    and returns {rows, total, facet_counts} — so the href is synthesized here
    rather than read off the payload."""
    rows = page["rows"]
    lines = [
        f"{page['total']} technolog(ies) match"
        + (f" {query!r}" if query else "")
        + f"; showing {len(rows)}.",
        "",
    ]
    lines += _table(
        [
            [
                r["slug"],
                r["kind"],
                r["layer"] or "—",
                r["adoption"] or "(no stance)",
                ", ".join(r["satisfies"]) or "—",
                f"{r['used_by']} product(s)",
            ]
            for r in rows
        ]
    )
    lines.append("")
    lines.append(f"Open: /tech{f'?q={query}' if query else ''}")
    return "\n".join(lines)


def propose_binding(slot: str, tech: str, rationale: str, href: str) -> str:
    """The hand-off, not a mutation. It exists so an agent has something useful
    to do at the end of a recommendation other than nothing."""
    return "\n".join(
        [
            f"Proposal: bind {slot} → {tech}",
            f"Rationale: {rationale}",
            "Not applied. Binding a slot is a human action.",
            f"Confirm at: {href}",
        ]
    )


def blocked(reason: str, rule_id: str, href: str) -> str:
    """A hard stop. Both stop conditions trace to an id someone wrote down."""
    return "\n".join([f"Stop — {reason}", f"Rule: {rule_id}", f"Open: {href}"])


def api_error(status: int, body: Any) -> str:
    """A refusal from the API, rendered rather than swallowed. The 403 already
    carries the screen that can act; pass it through verbatim."""
    if isinstance(body, dict) and isinstance(body.get("detail"), dict):
        detail = body["detail"]
        return "\n".join(
            [
                f"Refused ({status}): {detail.get('error', 'error')}",
                detail.get("message", ""),
                f"Open: {detail.get('href', '/')}",
            ]
        )
    return f"Refused ({status}): {body}"


# ---- inventory: what exists, and what we could build from it ----
# Same four rules. Two more, from the product's own: a gap is an answer, and a
# near name is a candidate for a human to confirm, never a match.


def _names(refs: list[dict]) -> str:
    return ", ".join(r["slug"] for r in refs)


def _end(lines: list[str], href: str) -> str:
    lines.append(f"Open: {href}")
    return "\n".join(lines)


def _candidates(candidates: list[dict]) -> str:
    return ", ".join(
        f"{c['slug']} ({c['maturity']}{'' if c['ours'] else ', external only'})"
        for c in candidates
    )


def products(rows: list[dict]) -> str:
    external = sum(1 for r in rows if r["external"])
    lines = [f"{len(rows)} product(s): {len(rows) - external} ours, {external} external.", ""]
    lines += _table(
        [[r["slug"], "external" if r["external"] else "ours", r["name"], r["id"]] for r in rows]
    )
    if not rows:
        lines.append("No products recorded yet.")
    lines.append("")
    return _end(lines, "/products")


def capability_inventory(rows: list[dict], query: str | None, limit: int = 50) -> str:
    """The endpoint has no filter, so filter here — in arrival order, which is
    already most reused first."""
    total = len(rows)
    if query:
        q = query.lower()
        rows = [r for r in rows if q in r["name"].lower() or q in r["slug"]]
    shown = rows[: max(0, limit)]
    in_use = sum(1 for r in rows if r["ours"] and r["features"])
    unbuilt = sum(1 for r in rows if r["ours"] and not r["features"])
    outside = sum(1 for r in rows if not r["ours"])
    head = (
        f"{len(rows)} of {total} capabilit(ies) match {query!r}"
        if query
        else f"{total} capabilit(ies)"
    )
    lines = [
        f"{head}: {in_use} ours with features, {unbuilt} ours with no feature yet, "
        f"{outside} known only from external products; showing {len(shown)}.",
        "",
    ]
    lines += _table(
        [
            [
                r["slug"],
                r["maturity"],
                f"{r['features']} feature(s)",
                f"ours in: {_names(r['products'])}" if r["products"] else "ours in: —",
                f"external: {_names(r['external_products'])}" if r["external_products"] else "",
                "" if r["ours"] else "external only — not ours",
            ]
            for r in shown
        ]
    )
    if query and not rows:
        lines.append(
            f"Nothing named like {query!r}. That is an answer: we don't have it under that name."
        )
    lines.append("")
    return _end(lines, "/capabilities")


def _need(need: dict) -> list[str]:
    match = need["match"]
    if match and match["ours"]:
        where = _names(match["products"]) or "no product listed"
        return [
            f"  ours           {need['name']} → {match['slug']} "
            f"({match['maturity']}; in {where})"
        ]
    if match:
        return [
            f"  external only  {need['name']} → {match['slug']} "
            f"(only in {_names(match['external_products'])}) — exists, not ours"
        ]
    lines = [f"  no match       {need['name']}"]
    if need["candidates"]:
        lines.append(f"    near names, unconfirmed: {_candidates(need['candidates'])}")
    return lines


def check_idea(report: dict, idea: str) -> str:
    not_ours = report["missing"]
    lines = [
        f"{report['existing']}/{report['needed']} distinct capabilit(ies) are ours, "
        f"{report['mature']} of them proven (beta or ga); {len(not_ours)} not ours.",
        "",
    ]
    for feature in report["features"]:
        lines.append(f"{feature['name']}: {feature['existing']}/{feature['total']} ours")
        for need in feature["capabilities"]:
            lines += _need(need)
    if not_ours:
        lines += [
            "",
            f"Not ours ({len(not_ours)}): {', '.join(not_ours)}",
            "A gap is an answer: build these, or confirm a near name is the same capability.",
        ]
    lines += [
        "Matched by exact name (slug). Near names are candidates for a human to "
        "confirm, never counted as matches.",
        "",
    ]
    return _end(lines, idea_link(idea, report))


def idea_link(idea: str, report: dict) -> str:
    """Home's idea check, pre-filled: every distinct need once, in order, as
    its slug when matched and as typed when not. The per-feature split is not
    carried; the distinct-capability count is the same."""
    caps: list[str] = []
    for feature in report["features"]:
        for need in feature["capabilities"]:
            token = need["match"]["slug"] if need["match"] else need["name"]
            if token not in caps:
                caps.append(token)
    joined = ",".join(quote(c, safe="") for c in caps)
    return f"/home?idea={quote(idea, safe='')}&caps={joined}"


def product_score(score: dict) -> str:
    """Four groups that sum to the total. The API gives three lists; the fourth
    — features fully described but missing a capability — is what's left."""
    total = score["total_features"]
    buildable = score["buildable"]
    partly = score["known_covered"]
    not_described = [n for n in score["unknown_features"] if n not in partly]
    missing = total - len(buildable) - len(score["unknown_features"])
    product = score["product"]
    lines = [
        f"{len(buildable)}/{total} feature(s) of {product['slug']} buildable from what we "
        f"have; {len(partly)} partly known, {len(not_described)} not described, "
        f"{missing} missing a capability.",
        "",
    ]
    report = score.get("report")
    short = [
        f["name"]
        for f in (report["features"] if report else [])
        if f["existing"] < f["total"] and f["name"] not in score["unknown_features"]
    ]
    for label, names in (
        ("Buildable — every capability known and ours", buildable),
        ("Partly known (known_covered) — every named capability ours, list incomplete", partly),
        ("Not described — capability list incomplete and not covered", not_described),
        ("Missing a capability — fully described, needs one we don't have", short),
    ):
        if names:
            lines.append(f"{label} ({len(names)}): {', '.join(names)}")
    if report:
        lines.append(
            f"Across its named capabilities: {report['existing']}/{report['needed']} ours, "
            f"{report['mature']} proven (beta or ga)."
        )
        if report["missing"]:
            lines.append(f"Not ours ({len(report['missing'])}): {', '.join(report['missing'])}")
    else:
        lines.append("No capability is named on any of its features, so nothing can be scored.")
    lines += [
        "Lower bound: a feature with an incomplete capability list never counts as buildable.",
        "",
    ]
    return _end(lines, f"/products?product={product['id']}")


def no_product(value: str) -> str:
    return _end(
        [f"0 products have id or slug {value!r}. Call `products` for ids and slugs."],
        "/products",
    )


def capability(
    entry: dict, features: list[dict], goals: list[dict], rollup: dict, products: list[dict]
) -> str:
    """Who uses it, why, and how far along. Features are ours, over the
    capability's submap — the same set the rollup counts."""
    slug = entry["slug"]
    by_id = {p["id"]: p["slug"] for p in products}
    lines = [
        f"{entry['features']} feature(s) of ours realize {slug} across "
        f"{len(entry['products'])} product(s); maturity {entry['maturity']}.",
    ]
    if not entry["ours"]:
        lines.append("Known only from external products: it exists, we don't have it.")
    description = entry.get("description")
    lines.append(entry["name"] + (f" — {description}" if description else ""))
    lines += [
        "",
        f"Rollup: {rollup['total']} total — {rollup['pending']} pending, "
        f"{rollup['in_progress']} in_progress, {rollup['done']} done.",
        f"Our products: {_names(entry['products']) or '—'}",
        f"External products that have it: {_names(entry['external_products']) or '—'}",
    ]
    anchors = entry.get("evidence_anchors") or []
    if anchors:
        # Paths as an export recorded them, relative to the exporting repo's
        # root. They belong to the capability, not to any one product.
        lines.append(f"Evidence ({len(anchors)} path(s), as exported): {', '.join(anchors)}")
    if features:
        lines += ["", f"Our features ({len(features)}):"]
        lines += _table(
            [
                [f["name"], f["status"], by_id.get(f["product_id"], "(no product)"), f["id"]]
                for f in features
            ]
        )
    lines.append("")
    if goals:
        lines.append(f"Motivated directly by {len(goals)} goal(s):")
        lines += _table([[g["display_id"], g["status"], g["title"]] for g in goals])
    else:
        lines.append("No goal motivates it directly. That is an answer, not a missing lookup.")
    lines.append("")
    return _end(lines, f"/capabilities/{slug}")


def no_capability(slug: str, candidates: list[dict]) -> str:
    lines = [f"0 capabilities have slug {slug!r}. Matching is exact."]
    if candidates:
        lines.append(f"Near names, unconfirmed: {_candidates(candidates)}")
    else:
        lines.append("No near names either: we don't have it.")
    return _end(lines, "/capabilities")


def feature_why(why: dict) -> str:
    chain = why["chain"]
    capabilities = sum(1 for s in chain if s["kind"] == "capability")
    goals = sum(1 for s in chain if s["kind"] == "goal")
    lines = [
        f"{capabilities} capabilit(ies) and {goals} goal(s) above {chain[0]['name']}.",
        "",
    ]
    lines += _table(
        [
            [s["relation"] or "—", s["kind"], s.get("display_id") or "", s["name"]]
            for s in chain[1:]
        ]
    )
    if not goals:
        lines.append(
            "No goal motivates any capability on this path — the why stops here. "
            "That is an answer."
        )
    lines.append("")
    return _end(lines, f"/features?feature={why['feature_id']}")


def journeys(rows: list[dict]) -> str:
    lines = [f"{len(rows)} journey(s).", ""]
    lines += _table(
        [[r["name"], r["persona"] or "—", f"{len(r['steps'])} step(s)", r["id"]] for r in rows]
    )
    if rows:
        lines += ["", "Pass a journey id for its step-by-step analysis."]
    lines.append("")
    return _end(lines, "/journeys")


def journey_analysis(analysis: dict) -> str:
    journey = analysis["journey"]
    steps = analysis["steps"]
    counts = analysis["counts"]
    tally = ", ".join(
        f"{counts[k]} {k}" for k in ("buildable", "known_covered", "missing", "unknown")
    )
    lines = [
        f"{len(steps)} step(s) in {journey['name']}: {tally}; {analysis['live']} live today.",
        "",
    ]
    rows = []
    for s in steps:
        feature = s["feature"]
        if feature is None:
            where = "not built"
        else:
            where = feature["status"]
            if feature["product"]:
                where += f" in {feature['product']['slug']}"
                where += " (external)" if feature["external"] else ""
        rows.append(
            [str(s["position"]), s["verdict"], "live" if s["live"] else "", s["label"], where]
        )
    lines += _table(rows)
    for s in steps:
        if s["verdict"] != "missing" or not s["coverage"]:
            continue
        gaps = [
            n["name"]
            for n in s["coverage"]["capabilities"]
            if not (n["match"] and n["match"]["ours"])
        ]
        lines.append(f"  {s['label']} needs, not ours: {', '.join(gaps)}")
    lines.append("")
    if analysis["products"]:
        lines.append(f"Our products on the path: {_names(analysis['products'])}")
    if analysis["external_products"]:
        lines.append(f"External products on the path: {_names(analysis['external_products'])}")
    report = analysis.get("report")
    if report and report["missing"]:
        lines.append(f"Not ours ({len(report['missing'])}): {', '.join(report['missing'])}")
    lines.append("")
    return _end(lines, f"/journeys?id={journey['id']}")


def ready_features(
    rows: list[dict], products: list[dict], only: dict | None, pending: int | None = None
) -> str:
    """The graph serves the whole frontier; one product is a filter over it, in
    the graph's order (priority, then age). `pending` counts our pending
    features in scope, asked for only when nothing is ready."""
    by_id = {p["id"]: p["slug"] for p in products}
    if only:
        rows = [r for r in rows if r["product_id"] == only["id"]]
    scope = f" in {only['slug']}" if only else ""
    lines = [
        f"{len(rows)} feature(s) ready to start{scope} — pending, every dependency done.",
        "",
    ]
    lines += _table(
        [
            [
                r["name"],
                f"P{r['priority']}" if r["priority"] else "no priority",
                by_id.get(r["product_id"], "(no product)"),
                r["id"],
            ]
            for r in rows
        ]
    )
    if rows:
        lines.append("")
        return _end(lines, "/features")
    if pending:
        lines.append(
            f"Nothing is ready{scope}: {pending} pending feature(s), each waits on one not done."
        )
    else:
        lines.append(f"Nothing is pending{scope}: every feature of ours is in progress or done.")
    lines += [
        "To find what to build next, check an idea against what already exists with "
        "check_idea. Its Open: line pre-fills Home's idea check for the owner.",
        "",
    ]
    return _end(lines, "/home")
