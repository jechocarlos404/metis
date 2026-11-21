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


def _tight(lines: list[str]) -> list[str]:
    """One blank line at most between parts: an empty table between two
    blank lines would otherwise leave a gap that says nothing."""
    out: list[str] = []
    for line in lines:
        if line == "" and (not out or out[-1] == ""):
            continue
        out.append(line)
    return out


def _tail(envelope: dict, lines: list[str], *, stamp: bool = False) -> str:
    lines = _tight(lines)
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
    if not rows:
        lines.append(
            "No technology is recorded as satisfying it. That is an answer; a seed file's "
            "technologies, or the API, record one."
        )
    lines += _table(
        [
            [
                r["tech"],
                r["fit"],
                r["stance"] or "(no stance)",
                f"ops {r['cost']['ops_burden']}"
                if r["cost"].get("ops_burden") is not None  # 0..3; 0 is a burden of none
                else "ops not recorded",
                "← bound in " + ", ".join(r["bound_in"]) if r["bound_in"] else "",
            ]
            for r in rows
        ]
    )
    realizations = envelope.get("realizations") or []
    # An external product's feature is known, never our build side.
    ours = [f for f in realizations if not f.get("external")]
    theirs = [f for f in realizations if f.get("external")]
    if ours:
        # Any status: a feature in progress realizes it without making it ours.
        done = sum(1 for f in ours if f["status"] == "done")
        # The count rolls up the submap, as `capability` labels it.
        through = sum(1 for f in ours if f.get("via"))
        via = f" ({through} only through its sub-capabilities)" if through else ""
        lines += [
            "",
            f"Build side — {len(ours)} feature(s) of ours{via} realize it, any status ({done} done):",
        ]
        lines += _table(
            [
                [f["feature"], f["status"], f"{f['tickets']} ticket(s)", f["product"] or ""]
                for f in ours
            ]
        )
    if theirs:
        lines += ["", f"External products — {len(theirs)} feature(s), not ours:"]
        lines += _table([[f["feature"], f["status"], f["product"] or ""] for f in theirs])
    lines.append("")
    return _tail(envelope, lines)


def tech_blast_radius(envelope: dict) -> str:
    rows = envelope["answer"]
    slug = envelope["subject"]["slug"]
    breaks = sum(1 for r in rows if r["required"])
    off = sum(1 for r in rows if r["off_stack"])
    bare = sum(1 for r in rows if r["layer"] is None and not r["off_stack"])
    lines = [
        f"{len(rows)} product(s) use {slug} — {breaks} required, {off} off_stack, "
        f"{bare} with no stack.",
        "",
    ]

    def use(r: dict) -> str:
        # required/optional are stack words: only a slot says how much it's needed.
        if r["layer"] is not None:
            return "required" if r["required"] else "optional"
        if r["off_stack"]:
            return "off_stack (its stack never declared it)"
        return "uses it (the product has no stack)"

    lines += _table([[r["product"], r["layer"] or "—", r["role"] or "—", use(r)] for r in rows])
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
    # Filtered to a product, the answer is about what that product uses only.
    subject = envelope["subject"]
    product = subject["slug"] if subject.get("kind") == "product" else None
    # A row's products and slots are the technology's, estate-wide; say so
    # when the rows are one product's.
    lines = [
        f"{len(rows)} exposed technolog(ies){f' used by {product}' if product else ''}, "
        f"{at_risk} required slot(s) affected"
        f"{' across every product that uses them' if product else ''}.",
        "",
    ]
    if not rows and product is None:
        # Nothing exposed is only an all-clear for what exposure can see.
        lines.append(
            "Nothing recorded reaches its end of life in the window, has a deprecated or "
            "banned stance, or rests on a single maintainer. tech_search shows what is "
            "recorded at all."
        )
    elif not rows and not envelope.get("unresolved"):
        # Otherwise the Unresolved line says what it couldn't judge.
        lines.append(
            f"Nothing {product} is recorded as using reaches its end of life in the window, "
            "has a deprecated or banned stance, or rests on a single maintainer."
        )
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
    if not rows and not unresolved:
        lines.append(
            f"{envelope['subject']['slug']} has no stack slot to bind. A stack is recorded "
            "only through the API (POST /api/stacks); the app and seed files never add one."
        )
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


def tech_search(page: dict, query: str | None, catalog: int | None = None) -> str:
    """The navigation tool. Not an envelope — the catalog endpoint predates it
    and returns {rows, total, facet_counts} — so the href is synthesized here
    rather than read off the payload. `catalog` is how many are recorded at
    all, read when nothing matched: an empty catalog is not an unknown name."""
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
    if not rows and not catalog:
        lines.append(
            "No technology is recorded yet, so nothing can match. A seed file's "
            "technologies, or the API, record them."
        )
    elif not rows:
        lines.append(
            f"None of the {catalog} recorded technolog(ies) match. That is an answer: "
            "it isn't recorded."
        )
    lines.append("")
    return _end(lines, f"/tech{f'?q={query}' if query else ''}")


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


def api_error(status: int, body: Any, href: str, hint: str | None = None) -> str:
    """A refusal from the API, rendered rather than swallowed. The 403 already
    carries the screen that can act; pass it through verbatim. Anything else
    opens the screen of the tool's own subject."""
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):
        lines = [f"Refused ({status}): {detail.get('error', 'error')}"]
        lines += [detail["message"]] if detail.get("message") else []
        href = detail.get("href") or href
    else:
        lines = [f"Refused ({status}): {_said(detail)}"]
    if hint:
        lines.append(hint)
    return _end(lines, href)


def _said(detail: Any) -> str:
    """The API's own words, on one line. FastAPI's validation errors arrive as
    a list; each keeps its location and message."""
    if isinstance(detail, list):
        return "; ".join(
            f"{'.'.join(str(part) for part in e.get('loc', []))}: {e.get('msg', '')}"
            for e in detail
            if isinstance(e, dict)
        )
    return " ".join(str(detail).split())[:300]


def error(message: str, href: str) -> str:
    """An input this server refused before asking, or a setup it cannot get
    past: one sentence saying what to change, then the screen as always."""
    return _end([message], href)


# ---- inventory: what exists, and what we could build from it ----
# Same four rules. Two more, from the product's own: a gap is an answer, and a
# near name is a candidate for a human to confirm, never a match.


def _names(refs: list[dict]) -> str:
    return ", ".join(r["slug"] for r in refs)


def _end(lines: list[str], href: str) -> str:
    lines = _tight(lines)
    lines.append(f"Open: {href}")
    return "\n".join(lines)


def _standing(c: dict) -> str:
    """Maturity describes our implementation, so it shows only when ours.
    `ours` false means one of two things; external_products tells which."""
    if c["ours"]:
        return c["maturity"]
    return "only elsewhere" if c["external_products"] else "not built yet"


def _candidates(candidates: list[dict]) -> str:
    return ", ".join(f"{c['slug']} \"{c['name']}\" ({_standing(c)})" for c in candidates)


def products(rows: list[dict]) -> str:
    external = sum(1 for r in rows if r["external"])
    lines = [f"{len(rows)} product(s): {len(rows) - external} ours, {external} external.", ""]
    lines += _table(
        [
            [
                r["slug"],
                "external" if r["external"] else "ours",
                # seeded_at: when its seed file was last imported (ISO), or never.
                r.get("seeded_at") or "never",
                r["name"],
                r["id"],
            ]
            for r in rows
        ]
    )
    if not rows:
        lines.append("No products recorded yet.")
    lines.append("")
    return _end(lines, "/products")


def product_features(product: dict, features: list[dict]) -> str:
    """One product's features, so an agent can pass one to feature_why or
    recheck without guessing a name. Statuses raw, in the API's order."""
    counts = {s: sum(1 for f in features if f["status"] == s) for s in ("done", "in_progress", "pending")}
    said = ", ".join(f"{n} {s}" for s, n in counts.items() if n)
    whose = "external" if product["external"] else "ours"
    lines = [f"{len(features)} feature(s) of {product['slug']} ({whose}){': ' + said if said else ''}.", ""]
    lines += _table([["  " + f["name"], f["status"], f["id"]] for f in features])
    if not features:
        lines.append("None recorded yet: features are added on the desktop or by a seed file.")
    lines.append("")
    return _end(lines, f"/features?product={product['id']}")


def _through(entry: dict) -> str:
    """The feature count rolls up the submap; say how much of it is a
    sub-capability's link, as `capability` does."""
    through = entry["features"] - entry.get("direct_features", entry["features"])
    return f" ({through} only through its sub-capabilities)" if through else ""


def capability_inventory(rows: list[dict], query: str | None, limit: int = 50) -> str:
    """The endpoint has no filter, so filter here — in arrival order, which is
    already most reused first."""
    total = len(rows)
    if query:
        q = query.lower()
        rows = [r for r in rows if q in r["name"].lower() or q in r["slug"]]
    shown = rows[: max(0, limit)]
    in_use = sum(1 for r in rows if r["ours"])
    outside = sum(1 for r in rows if not r["ours"] and r["external_products"])
    unbuilt = len(rows) - in_use - outside
    head = (
        f"{len(rows)} of {total} capabilit(ies) match {query!r}"
        if query
        else f"{total} capabilit(ies)"
    )
    lines = [
        f"{head}: {in_use} ours, {outside} only elsewhere, "
        f"{unbuilt} not built yet; showing {len(shown)}.",
        "",
    ]
    # The exact name rides along: a seed file reuses a capability by its name.
    # Maturity describes our implementation, so it shows only when ours; the
    # feature count and our products are our work on it at any status.
    lines += _table(
        [
            [
                r["slug"],
                f'"{r["name"]}"',
                r["maturity"] if r["ours"] else "—",
                f"{r['features']} feature(s){_through(r)}",
                f"our products, any status: {_names(r['products'])}"
                if r["products"]
                else "our products: —",
                f"external: {_names(r['external_products'])}" if r["external_products"] else "",
                ""
                if r["ours"]
                else "only elsewhere — not ours"
                if r["external_products"]
                else "not built yet — not ours",
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
        # Our products with work on it at any status: one of them finished
        # it, which is what makes it ours, but not necessarily each.
        where = _names(match["products"]) or "no product listed"
        return [
            f"  ours           {need['name']} → {match['slug']} "
            f"({match['maturity']}; our products on it, any status: {where})"
        ]
    if match and match["external_products"]:
        return [
            f"  only elsewhere {need['name']} → {match['slug']} "
            f"(external: {_names(match['external_products'])}) — exists, not ours"
        ]
    if match:
        return [
            f"  not built yet  {need['name']} → {match['slug']} "
            "(no finished feature realizes it) — not ours"
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
    """Four groups that sum to the total, as the API partitions them."""
    total = score["total_features"]
    buildable = score["buildable"]
    partly = score["partly"]
    not_described = score["not_described"]
    missing = score["missing"]
    product = score["product"]
    lines = [
        f"{len(buildable)}/{total} feature(s) of {product['slug']} buildable from what we "
        f"have; {len(partly)} partly known, {len(not_described)} not described, "
        f"{len(missing)} missing a capability.",
        "",
    ]
    report = score.get("report")
    for label, names in (
        ("Buildable — every capability known and ours", buildable),
        ("Partly known (partly) — every named capability ours, list incomplete", partly),
        ("Not described (not_described) — no capability named", not_described),
        ("Missing a capability — names one we don't have", missing),
    ):
        if names:
            lines.append(f"{label} ({len(names)}): {', '.join(names)}")
    if score["missing_incomplete"]:
        lines.append(
            f"Of the missing, {len(score['missing_incomplete'])} also have an incomplete "
            "capability list: what's named may not be all they need."
        )
    if report:
        lines.append(
            f"Across its named capabilities: {report['existing']}/{report['needed']} ours, "
            f"{report['mature']} proven (beta or ga)."
        )
        gaps = score["missing_capabilities"]
        if gaps:
            lines.append(
                f"Not ours ({len(gaps)}), most useful first. only_gap: features for which "
                "it is the one named capability we lack, so adding it covers what they name:"
            )
            lines += _table(
                [
                    [
                        f"  {g['slug'] or g['name']}",
                        f"needed by {g['features']}",
                        f"only_gap {g['only_gap']}",
                        f"elsewhere: {_names(g['elsewhere']) or 'none'}",
                    ]
                    for g in gaps
                ]
            )
        closest = score["closest_products"]
        if closest:
            # A tie is kept whole, so products with the same count share one group.
            tied: dict[int, list[str]] = {}
            for c in closest:
                tied.setdefault(c["capabilities"], []).append(c["product"]["slug"])
            lines.append(
                f"Closest of our products, by how many of the {report['needed']} named "
                "capabilities each has built: "
                + "; ".join(f"{n} {', '.join(slugs)}" for n, slugs in tied.items())
            )
    else:
        lines.append("No capability is named on any of its features, so nothing can be scored.")
    lines += [
        "Lower bound: a feature with an incomplete capability list never counts as buildable.",
        "",
    ]
    return _end(lines, f"/products?product={product['id']}")


def _near(offered: list[str]) -> list[str]:
    """Near names after an exact miss, as no_capability offers them: each
    leads with what the next call takes. Unconfirmed, never picked."""
    return [f"Near names, unconfirmed: {', '.join(offered)}"] if offered else []


def no_product(value: str, near: list[dict] = ()) -> str:
    return _end(
        [
            f"0 products have id or slug {value!r}. Call `products` for ids and slugs.",
            *_near([f'{p["slug"]} "{p["name"]}"' for p in near]),
        ],
        "/products",
    )


def external_product_work(product: dict) -> str:
    """Someone else's product has no work of ours to start, as product_score
    declines one of ours in reverse."""
    return _end(
        [
            f"0 feature(s) ready to start in {product['slug']}: it is external, and "
            "its features are never our work. Call ready_features without a product, "
            "or with one of ours.",
        ],
        f"/products?product={product['id']}",
    )


def no_tech(slug: str) -> str:
    return _end(
        [f"0 technologies have slug {slug!r}. Matching is exact; tech_search lists them."],
        "/tech",
    )


def no_slot(slot: str) -> str:
    return _end(
        [f"0 slots have id {slot!r}. The metis://stacks/{{product}} resource lists a product's slots."],
        "/stacks",
    )


def own_product(product: dict) -> str:
    """Our own products are not scored, as on the desktop: a product's own
    features are what make its capabilities ours, so the score measures itself."""
    return _end(
        [
            f"0 features scored: {product['slug']} is ours, and product_score scores "
            "only external products. For one of ours, ready_features says what can "
            "start next and recheck what a change touches.",
        ],
        f"/products?product={product['id']}",
    )


def capability(
    entry: dict, features: list[dict], goals: list[dict], rollup: dict, products: list[dict]
) -> str:
    """Who uses it, why, and how far along. Features are ours, over the
    capability's submap — the same set the rollup counts."""
    slug = entry["slug"]
    by_id = {p["id"]: p["slug"] for p in products}
    # The count is our work on it at any status; whether it is ours takes a
    # finished one. Maturity describes our implementation, so only when ours.
    maturity = f"; maturity {entry['maturity']}" if entry["ours"] else ""
    # The count rolls up the submap; say how much of it is a sub-capability's
    # link, so it isn't read as direct links (a seed removal counts those).
    through = sum(1 for f in features if entry["id"] not in f.get("capability_ids", []))
    via = f" ({through} only through its sub-capabilities)" if through else ""
    lines = [
        f"{entry['features']} feature(s) of ours{via}, at any status, realize {slug} across "
        f"{len(entry['products'])} product(s){maturity}.",
    ]
    if not entry["ours"] and entry["external_products"]:
        lines.append(
            "Not ours: no finished feature of ours realizes it. External products have it."
        )
    elif not entry["ours"]:
        lines.append("Not built yet: no finished feature realizes it, so it isn't ours.")
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


def feature_why(
    why: dict,
    feature: dict,
    products: list[dict],
    goals: list[dict],
    motivations: list[dict],
) -> str:
    """The chain, split by whose goal it is. A goal is the feature's own when it
    belongs to the feature's product (the goals API's product_id, the desktop's
    rule); any other arrived through a shared capability — reuse, not the reason
    this feature exists — so it is labelled with its product. Each goal says
    which capability it motivates, or which goal it is the parent of, because
    the chain lists a goal once however many capabilities it motivates."""
    chain = why["chain"]
    parent = {g["id"]: g["parent_goal_id"] for g in goals}
    owner = {g["id"]: g["product_id"] for g in goals}
    slugs = {p["id"]: p["slug"] for p in products}
    product = next((p for p in products if p["id"] == feature.get("product_id")), None)
    slug = product["slug"] if product else "(no product)"
    product_id = product["id"] if product else None
    owns_goals = product_id is not None and product_id in owner.values()

    capabilities = [s for s in chain if s["kind"] == "capability"]
    steps = [s for s in chain if s["kind"] == "goal"]
    order = [s["id"] for s in capabilities]
    names = {s["id"]: s["name"] for s in capabilities}
    motivates: dict[str, list[str]] = {}
    for m in motivations:
        if m["capability_id"] in names:
            motivates.setdefault(m["goal_id"], []).append(m["capability_id"])

    def via(step: dict) -> str:
        said = []
        motivated = sorted(motivates.get(step["id"], []), key=order.index)
        if motivated:
            said.append("motivates " + ", ".join(names[c] for c in motivated))
        children = [g["display_id"] for g in steps if parent.get(g["id"]) == step["id"]]
        if children:
            said.append("parent of " + ", ".join(children))
        return "; ".join(said)

    own = [g for g in steps if product_id is not None and owner.get(g["id"]) == product_id]
    other = [g for g in steps if g not in own]
    # Only a product with a goal owns any, so this is set whenever owns_goals is.
    goal = next((g for g in goals if product and g["id"] == product.get("goal_id")), None)
    lines = [
        f"{len(capabilities)} capabilit(ies) and {len(steps)} goal(s) above "
        f"{chain[0]['name']} ({slug}): {len(own)} of {slug}, "
        f"{len(other)} of other products.",
        "",
    ]
    lines += _table([["  " + s["relation"], s["name"]] for s in capabilities])
    lines.append("")
    if product and product.get("external") and not owns_goals:
        lines.append(f"{slug} is someone else's product: metis doesn't record its goals.")
    elif not steps:
        lines.append(
            "No goal motivates any capability on this path — the why stops here. "
            "That is an answer."
        )
    elif own:
        lines.append(f"Goals of {slug} ({len(own)}):")
        lines += _table([["  " + g["display_id"], g["name"], via(g)] for g in own])
    elif not owns_goals:
        lines.append(f"{slug} has no goal of its own, so none of these is its reason.")
    else:
        lines.append(
            f"No goal of {slug} motivates these capabilities; its goal is "
            f"{goal['display_id']} {goal['title']}."
        )
    if other:
        lines.append(
            f"Goals of other products ({len(other)}) — each motivates a capability "
            "this feature shares, not this feature:"
        )
        lines += _table(
            [
                [
                    "  " + g["display_id"],
                    g["name"],
                    slugs.get(owner.get(g["id"]), "(no product)"),
                    via(g),
                ]
                for g in other
            ]
        )
    lines.append("")
    return _end(lines, f"/features?feature={why['feature_id']}")


def journeys(rows: list[dict]) -> str:
    lines = [f"{len(rows)} journey(s).", ""]
    if not rows:
        lines.append(
            "No journey is recorded yet. Home's idea check saves one (Save as idea); "
            "check_idea answers the same question without saving."
        )
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


def recheck(result: dict, products: list[dict]) -> str:
    """Four groups in the endpoint's order, most relevant first. Only breaks
    and retest are lists to work through; broad is a count and elsewhere is
    information, because metis does not know whether products share code."""
    feature = result["feature"]
    by_id = {p["id"]: p["slug"] for p in products}
    breaks, retest, broad, elsewhere = (
        result[k] for k in ("breaks", "retest", "broad", "elsewhere")
    )
    lines = [
        f"{len(breaks)} feature(s) break and {len(retest)} to retest in the same product "
        f"if {feature['name']} changes; {len(broad)} broad capabilit(ies), "
        f"{len(elsewhere)} other product(s) with the same capabilities.",
        "",
        f"Breaks ({len(breaks)}): they depend on it, directly or through links of links.",
    ]
    lines += _table(
        [
            [
                "  " + b["name"],
                "direct" if b["direct"] else "via " + " → ".join(b["via"]),
                by_id.get(b["product_id"], "(no product)"),
                b["id"],
            ]
            for b in breaks
        ]
    )
    lines += [
        "",
        f"Retest (same product) ({len(retest)}): they share a confirmed capability, "
        "rarest shared capability first.",
    ]
    lines += _table(
        [
            [
                "  " + r["name"],
                f"score {r['score']}",
                "shares: " + ", ".join(c["name"] for c in r["shared"]),
                r["id"],
            ]
            for r in retest
        ]
    )
    if not feature["capability_ids"]:
        lines.append("  It has no confirmed capability, so nothing to retest by capability.")
    lines += [
        "",
        f"Broad (many features) ({len(broad)}): used by most of the product, counted not listed.",
    ]
    lines += _table([["  " + b["name"], f"{b['features']} feature(s)"] for b in broad])
    lines += [
        "",
        f"Same capability elsewhere (info only) ({len(elsewhere)}): metis does not know "
        "whether these products share code.",
    ]
    lines += _table(
        [
            ["  " + e["name"], f"{e['features']} feature(s)", ", ".join(e["capabilities"])]
            for e in elsewhere
        ]
    )
    lines += ["", "Capability guesses are not counted, only confirmed links.", ""]
    return _end(lines, f"/features?feature={feature['id']}")


def no_feature(
    value: str, named: list[dict], products: list[dict], near: list[dict] = ()
) -> str:
    """Exact names only. A name several features share is listed, not picked;
    a name none has offers the near ones."""
    by_id = {p["id"]: p["slug"] for p in products}
    if not named:
        return _end(
            [
                f"0 features are named {value!r}. Matching is exact: pass an id or the exact name.",
                *_near(
                    [f'{f["id"]} "{f["name"]}" ({by_id.get(f["product_id"], "no product")})' for f in near]
                ),
            ],
            "/features",
        )
    lines = [f"{len(named)} features are named {value!r}. Pass one id:", ""]
    lines += _table(
        [["  " + f["name"], by_id.get(f["product_id"], "(no product)"), f["id"]] for f in named]
    )
    lines.append("")
    return _end(lines, "/features")


def no_journey(value: str, named: list[dict], near: list[dict] = ()) -> str:
    """The same rule as features: an id or the exact name, never a near one,
    which is only offered."""
    if not named:
        return _end(
            [
                f"0 journeys are named {value!r}. Matching is exact: pass an id or the "
                "exact name; journeys with no argument lists them.",
                *_near([f'{j["id"]} "{j["name"]}"' for j in near]),
            ],
            "/journeys",
        )
    lines = [f"{len(named)} journeys are named {value!r}. Pass one id:", ""]
    lines += _table([["  " + j["name"], j["persona"] or "—", j["id"]] for j in named])
    lines.append("")
    return _end(lines, "/journeys")
