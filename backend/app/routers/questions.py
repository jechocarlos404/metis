"""The six questions, in one envelope.

Every computation here already exists in the technologies and stacks services.
This module adds nothing but the shared shape — which is the point: the answer
a human reads, the JSON an API consumer parses and the text an agent quotes are
renderings of one row set, not three implementations that drift apart.

A gap is an answer. An empty `answer` with a populated `unresolved` returns 200
and says why; 404 is reserved for a subject that does not exist.
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.throttle import throttle_people
from app.db import get_db
from app.models import Capability, Product, StackSlot, TechFit, Technology, TechStack
from app.schemas.envelope import (
    Answer,
    Question,
    RecommendRequest,
    SubjectKind,
    Unresolved,
    envelope,
)
from app.services import stacks as stack_service
from app.services import technologies as tech_service
from app.services.slugs import by_slug

#: Every question is a read, and the spec makes them cacheable for a minute.
#: Applied once here rather than per endpoint, so a new question cannot forget
#: it — and paired with `as_of` in the body, which is what tells a caller how
#: stale the copy in front of them actually is.
CACHE_SECONDS = 60


async def cacheable(response: Response) -> None:
    response.headers["Cache-Control"] = f"max-age={CACHE_SECONDS}"


router = APIRouter(prefix="/api", tags=["questions"], dependencies=[Depends(cacheable)])

#: One document, three readers: this endpoint, the /ontology route, and the
#: `metis://ontology/model` MCP resource. Not a copy and not a summary — if it
#: forks, agents start inventing private words for SATISFIES and the
#: transcripts stop being comparable. It lives inside the package rather than
#: in docs/ because the image only ships app/, and a doc that cannot deploy
#: cannot be the source of truth.
ONTOLOGY_DIR = Path(__file__).resolve().parent.parent / "ontology"
ONTOLOGY_MODEL = ONTOLOGY_DIR / "model.md"
ADOPTION_POLICY = ONTOLOGY_DIR / "adoptions.md"


def _serve(document: Path, label: str) -> PlainTextResponse:
    if not document.is_file():
        raise HTTPException(404, f"{label} is not on disk")
    # A custom Response bypasses the injected one, so the header is set here.
    return PlainTextResponse(
        document.read_text(encoding="utf-8"),
        media_type="text/markdown",
        headers={"Cache-Control": f"max-age={CACHE_SECONDS}"},
    )


@router.get("/ontology/model", response_class=PlainTextResponse)
async def ontology_model():
    return _serve(ONTOLOGY_MODEL, "Ontology model document")


@router.get("/ontology/adoptions", response_class=PlainTextResponse)
async def adoption_policy():
    """What each stance means and which ones are hard stops. Served so the MCP
    resource and any future UI read the same file the backend does."""
    return _serve(ADOPTION_POLICY, "Adoption policy document")


def _slot_name(slot: StackSlot) -> str:
    """`layer::role` — the spec's slot address, verbatim in both directions."""
    return f"{slot.layer}::{slot.role}"


@router.get("/capabilities/{slug}/supply", response_model=Answer)
async def capability_supply(
    slug: str,
    include_unadopted: bool = True,
    session: AsyncSession = Depends(get_db),
):
    """Question 1 — build or buy, in one frame.

    `answer` is the buy side, `realizations` the build side. Both sides of
    supply share one response because that is the question people actually
    hold: not "what exists" but "do we make this or take it"."""
    capability = await by_slug(session, Capability, slug, "Capability")
    offers = await tech_service.offers(session, capability.id)
    bound = await tech_service.bindings_by_tech(session)
    hidden = 0
    if not include_unadopted:
        kept = [o for o in offers if o.stance is not None]
        hidden = len(offers) - len(kept)
        offers = kept

    rows = [
        {
            "tech": o.slug,
            "fit": o.fit,
            "stance": o.stance,
            "cost": o.cost,
            "bound_in": bound.get(o.tech_id, []),
        }
        for o in offers
    ]
    unresolved = []
    if not rows:
        # Empty is allowed; empty and silent is not. Whatever emptied the list
        # has to say so — including this endpoint's own filter.
        blocked = await tech_service.blocked_reason(session, capability.id)
        if hidden:
            reason = f"{hidden} offer(s) hidden — none has an adoption stance"
        elif blocked:
            reason = "every offer is blocked by a constraint"
        else:
            reason = "no technology satisfies this capability"
        unresolved = [Unresolved(subject=slug, reason=reason, blocked_by=blocked)]
    return envelope(
        Question.capability_supply,
        SubjectKind.capability,
        slug,
        rows,
        f"/capabilities/{slug}",
        unresolved,
        realizations=await tech_service.realizations(session, capability.id),
    )


@router.get("/tech/{slug}/blast-radius", response_model=Answer)
async def tech_blast_radius(slug: str, session: AsyncSession = Depends(get_db)):
    """Question 2 — what breaks if we drop this, and what could replace it.

    The alternatives are appended because anyone asking this is mid-decision;
    the obvious next fact belongs in the same answer."""
    technology = await by_slug(session, Technology, slug, "Technology")
    breaks = await tech_service.dependents(session, technology.id)
    rows = [
        {
            "product": b.product,
            "layer": b.layer,
            "role": b.role,
            "required": b.required,
            "off_stack": b.off_stack,
        }
        for b in breaks
    ]

    alternatives: list[dict] = []
    seen: set[str] = {slug}
    for satisfaction in await tech_service.list_satisfactions(
        session, tech_id=technology.id
    ):
        for offer in await tech_service.offers(session, satisfaction.capability_id):
            if offer.slug not in seen:
                seen.add(offer.slug)
                alternatives.append(
                    {"tech": offer.slug, "fit": offer.fit, "stance": offer.stance}
                )

    unresolved = []
    if not rows:
        unresolved = [
            Unresolved(subject=slug, reason="no product records using this technology")
        ]
    return envelope(
        Question.tech_blast_radius,
        SubjectKind.technology,
        slug,
        rows,
        f"/tech/{slug}#blast-radius",
        unresolved,
        alternatives=alternatives,
    )


@router.get("/exposure", response_model=Answer)
async def tech_exposure(
    window_days: int = Query(default=180, ge=1, le=3650),
    product: str | None = None,
    session: AsyncSession = Depends(get_db),
):
    """Question 3 — what is dying, and does it matter.

    Three independent death modes in one list, sorted by required slots rather
    than by date: the unit of action is a row, and a number averaging three
    unrelated causes tells you nothing you can act on. This is the CI endpoint —
    a nightly job fails the build when required_slots is non-zero inside the
    window, so treat a change to this shape as breaking."""
    findings = await tech_service.exposure(session, window_days=window_days)
    if product is not None:
        target = await by_slug(session, Product, product, "Product")
        using = {
            usage.tech_id
            for usage in await stack_service.list_product_technologies(
                session, target.id
            )
        }
        findings = [f for f in findings if f.tech_id in using]

    rows = [
        {
            "tech": f.slug,
            "version": f.version,
            "reason": reason,
            "products": f.products,
            "required_slots": f.required_slots,
        }
        for f in findings
        for reason in [_exposure_reason(f)]
    ]
    return envelope(
        Question.tech_exposure,
        SubjectKind.estate,
        product or "estate",
        rows,
        f"/tech?view=exposure&window_days={window_days}",
    )


def _exposure_reason(finding) -> str:
    """`key:value`, machine-readable and identical on every surface. The first
    reason wins for display; all of them are still on the finding."""
    if "eol" in finding.reasons and finding.eol_on is not None:
        return f"eol_on:{finding.eol_on.isoformat()}"
    if "stance" in finding.reasons and finding.stance is not None:
        return f"stance:{finding.stance}"
    return f"bus_factor:{finding.bus_factor}"


@router.get("/stacks/{slug}/redundancy", response_model=Answer)
async def stack_redundancy(slug: str, session: AsyncSession = Depends(get_db)):
    """Question 4 — one capability answered twice.

    Reported, never resolved. Two frameworks can be a deliberate decision with
    history behind it; this endpoint does not get a vote."""
    product = await by_slug(session, Product, slug, "Product")
    findings = [r for r in await stack_service.redundancy(session) if r.product_id == product.id]
    layers = await _layer_by_capability(session, product.id)
    rows = [
        {
            "capability": r.capability,
            "layer": layers.get(r.capability_id),
            "competing": r.competing,
        }
        for r in findings
    ]
    return envelope(
        Question.stack_redundancy,
        SubjectKind.product,
        slug,
        rows,
        f"/stacks?product={slug}",
    )


async def _layer_by_capability(
    session: AsyncSession, product_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """Which layer a product's stacks answer a capability at. Presentation
    only — redundancy is defined by the capability, not the layer."""
    stmt = (
        select(StackSlot.capability_id, StackSlot.layer)
        .join(TechStack, TechStack.id == StackSlot.stack_id)
        .where(TechStack.product_id == product_id, StackSlot.capability_id.is_not(None))
    )
    return {cid: str(layer) for cid, layer in await session.execute(stmt)}


@router.get(
    "/tech/{slug}/encounters",
    response_model=Answer,
    dependencies=[Depends(throttle_people)],
)
async def tech_encounters(slug: str, session: AsyncSession = Depends(get_db)):
    """Question 5 — who here has touched this.

    The one endpoint that returns people. There is deliberately no unfiltered
    collection route: nobody should be able to enumerate the org through the
    tech catalog."""
    technology = await by_slug(session, Technology, slug, "Technology")
    encounters = await tech_service.list_encounters(session, technology.id)
    products = {p.id: p.slug for p in (await session.scalars(select(Product))).all()}
    rows = [
        {
            "person": e.person,
            "depth": str(e.depth),
            "last_at": e.last_at.isoformat(),
            "on_product": products.get(e.product_id),
        }
        for e in encounters
    ]
    unresolved = []
    if not rows:
        unresolved = [
            Unresolved(subject=slug, reason="nobody has recorded touching this")
        ]
    return envelope(
        Question.tech_encounters,
        SubjectKind.technology,
        slug,
        rows,
        f"/tech/{slug}#encounters",
        unresolved,
    )


@router.post("/stacks/{slug}/recommend", response_model=Answer)
async def stack_recommend(
    slug: str, data: RecommendRequest, session: AsyncSession = Depends(get_db)
):
    """Question 6 — what should this stack be.

    Deterministic throughout: supply, prune, rank. Nothing is persisted and no
    slot is filled — the response is an argument, and a required slot with no
    surviving offer stays a gap with the rule that made it one."""
    product = await by_slug(session, Product, slug, "Product")
    slots = await _slots_in_scope(session, product, data)

    rows: list[dict] = []
    pruned_rows: list[dict] = []
    unresolved: list[Unresolved] = []
    for slot in slots:
        name = _slot_name(slot)
        if slot.capability_id is None:
            unresolved.append(
                Unresolved(subject=name, reason="slot answers no capability")
            )
            continue
        surviving, pruned = await tech_service.ranked_offers(
            session, slot.capability_id, product.id, slot.stack_id
        )
        pruned_rows.extend(
            {
                "slot": name,
                "tech": o.slug,
                "blocked_by": o.blocked_by,
                "reason": "blocked by a constraint scoped to this product",
            }
            for o in pruned
        )
        if not surviving:
            unresolved.append(
                Unresolved(
                    subject=name,
                    reason=(
                        "no offer survives the constraints"
                        if pruned
                        else "nothing satisfies this slot's capability"
                    ),
                    blocked_by=sorted({n for o in pruned for n in o.blocked_by}),
                )
            )
            continue
        best = surviving[0]
        rows.append(
            {
                "slot": name,
                "tech": best.slug,
                "fit": best.fit,
                "stance": best.stance,
                "why": _why(best, surviving),
            }
        )
    return envelope(
        Question.stack_recommend,
        SubjectKind.product,
        slug,
        rows,
        f"/stacks?product={slug}",
        unresolved,
        pruned=pruned_rows,
    )


async def _slots_in_scope(
    session: AsyncSession, product: Product, data: RecommendRequest
) -> list[StackSlot]:
    """One slot, one stack's worth, or an archetype's shape. Asking for an
    archetype reads its slots without instantiating anything — recommending is
    not the same act as adopting."""
    if data.slot is not None:
        slot = await stack_service.get_slot(session, data.slot)
        stack = await stack_service.get_stack(session, slot.stack_id)
        if stack.product_id not in (None, product.id):
            raise HTTPException(422, "That slot belongs to a different product")
        return [slot]
    source = data.archetype or data.stack
    if source is not None:
        stack = await stack_service.get_stack(session, source)
        if not stack.is_archetype and stack.product_id != product.id:
            raise HTTPException(422, "That stack belongs to a different product")
        return await stack_service.list_slots(session, stack.id)
    slots: list[StackSlot] = []
    for stack in await stack_service.list_stacks(session, product_id=product.id):
        slots.extend(await stack_service.list_slots(session, stack.id))
    return slots


def _why(best, surviving) -> str:
    """The one sentence a model would otherwise write. Assembled from the same
    keys the ranking used, so the argument and the order cannot disagree."""
    reasons = [f"fit {best.fit}"]
    if best.stance is not None:
        reasons.append(f"stance {best.stance}")
    if best.experience is not None:
        reasons.append(f"{best.experience} here before")
    if best.fit == TechFit.workaround:
        reasons.append("workaround-grade — a known ceiling")
    runners = len(surviving) - 1
    tail = f"; {runners} other offer{'s' if runners != 1 else ''} ranked below" if runners else ""
    return ", ".join(reasons) + tail
