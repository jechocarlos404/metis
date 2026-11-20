"""Customer journeys: ordered paths of features, scored against the inventory.

A journey's analysis is derived on every read from the features' current links
and coverage() — nothing about it is stored except the path itself."""

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Feature, Journey, JourneyStep, WorkStatus
from app.schemas.capability import ProductRef
from app.schemas.journey import (
    JourneyAnalysis,
    JourneyCreate,
    JourneyRead,
    JourneyStepIn,
    JourneyUpdate,
    StepAnalysis,
    StepFeature,
)
from app.services.capabilities import list_capabilities, score_items


async def list_journeys(
    session: AsyncSession, feature_id: uuid.UUID | None = None
) -> list[Journey]:
    stmt = select(Journey).order_by(Journey.seq)
    if feature_id is not None:
        stmt = stmt.where(
            Journey.id.in_(select(JourneyStep.journey_id).where(JourneyStep.feature_id == feature_id))
        )
    return list((await session.scalars(stmt)).all())


async def get_journey(session: AsyncSession, journey_id: uuid.UUID) -> Journey:
    journey = await session.get(Journey, journey_id)
    if journey is None:
        raise HTTPException(404, "Journey not found")
    return journey


async def _steps(session: AsyncSession, steps_in: list[JourneyStepIn]) -> list[JourneyStep]:
    ids = {s.feature_id for s in steps_in if s.feature_id is not None}
    features = {
        f.id: f for f in (await session.scalars(select(Feature).where(Feature.id.in_(ids)))).all()
    } if ids else {}
    unknown = ids - features.keys()
    if unknown:
        raise HTTPException(404, f"Feature {sorted(map(str, unknown))[0]} not found")
    steps = []
    for position, s in enumerate(steps_in):
        feature = features.get(s.feature_id) if s.feature_id else None
        label = (s.label or "").strip() or (feature.name if feature else "")
        steps.append(
            JourneyStep(
                position=position,
                feature_id=s.feature_id,
                label=label,
                needs=[] if feature else [n.strip() for n in s.needs if n.strip()],
                note=s.note,
            )
        )
    return steps


async def create_journey(session: AsyncSession, data: JourneyCreate) -> Journey:
    journey = Journey(name=data.name.strip(), persona=data.persona, description=data.description)
    journey.steps = await _steps(session, data.steps)
    session.add(journey)
    await session.commit()
    return await get_journey(session, journey.id)


async def update_journey(
    session: AsyncSession, journey_id: uuid.UUID, data: JourneyUpdate
) -> Journey:
    journey = await get_journey(session, journey_id)
    fields = data.model_dump(exclude_unset=True, exclude={"steps"})
    for key, value in fields.items():
        setattr(journey, key, value.strip() if key == "name" else value)
    if data.steps is not None:
        journey.steps = await _steps(session, data.steps)
    await session.commit()
    session.expire(journey)
    return await get_journey(session, journey_id)


async def delete_journey(session: AsyncSession, journey_id: uuid.UUID) -> None:
    await session.delete(await get_journey(session, journey_id))
    await session.commit()


async def analyze(session: AsyncSession, journey_id: uuid.UUID) -> JourneyAnalysis:
    journey = await get_journey(session, journey_id)
    ids = {s.feature_id for s in journey.steps if s.feature_id is not None}
    features = {
        f.id: f for f in (await session.scalars(select(Feature).where(Feature.id.in_(ids)))).all()
    } if ids else {}
    names = {c.id: c.name for c in await list_capabilities(session)}

    items = []
    for step in journey.steps:
        feature = features.get(step.feature_id)
        caps = [names[c] for c in feature.capability_ids] if feature else list(step.needs)
        items.append((step.label, caps))
    report, scored = await score_items(session, items)

    steps, products, external = [], {}, {}
    for step, fc in zip(journey.steps, scored):
        feature = features.get(step.feature_id)
        incomplete = bool(feature and feature.unknown_capabilities)
        if fc is None:
            verdict = "unknown"
        elif fc.existing < fc.total:
            verdict = "missing"
        else:
            verdict = "known_covered" if incomplete else "buildable"
        ref = None
        if feature is not None:
            if feature.product is not None:
                bucket = external if feature.external else products
                bucket.setdefault(feature.product.id, ProductRef.model_validate(feature.product))
            ref = StepFeature(
                id=feature.id,
                name=feature.name,
                status=feature.status,
                unknown_capabilities=feature.unknown_capabilities,
                external=feature.external,
                product=ProductRef.model_validate(feature.product) if feature.product else None,
            )
        steps.append(
            StepAnalysis(
                position=step.position,
                label=step.label,
                note=step.note,
                feature=ref,
                live=bool(feature and not feature.external and feature.status == WorkStatus.done),
                verdict=verdict,
                coverage=fc,
            )
        )

    counts = {v: 0 for v in ("buildable", "known_covered", "missing", "unknown")}
    for s in steps:
        counts[s.verdict] += 1
    return JourneyAnalysis(
        journey=JourneyRead.model_validate(journey),
        steps=steps,
        products=list(products.values()),
        external_products=list(external.values()),
        counts=counts,
        live=sum(s.live for s in steps),
        report=report,
    )
