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
