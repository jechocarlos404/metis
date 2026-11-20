"""Guessed capability links: list, record, confirm, reject.

Confirming is the only way a guess becomes a fact: it creates the confirmed
link (feature_capabilities or tech_satisfactions) and deletes the guess, in
one commit."""

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Capability,
    CapabilityGuess,
    Feature,
    FeatureCapability,
    TechFit,
    TechSatisfaction,
    Technology,
)
from app.schemas.guess import GuessCreate, GuessRead


async def list_guesses(
    session: AsyncSession,
    *,
    feature_id: uuid.UUID | None = None,
    tech_id: uuid.UUID | None = None,
    capability_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
) -> list[GuessRead]:
    stmt = (
        select(CapabilityGuess, Capability, Feature, Technology)
        .join(Capability, Capability.id == CapabilityGuess.capability_id)
        .outerjoin(Feature, Feature.id == CapabilityGuess.feature_id)
        .outerjoin(Technology, Technology.id == CapabilityGuess.tech_id)
        .order_by(CapabilityGuess.seq)
    )
    if feature_id:
        stmt = stmt.where(CapabilityGuess.feature_id == feature_id)
    if tech_id:
        stmt = stmt.where(CapabilityGuess.tech_id == tech_id)
    if capability_id:
        stmt = stmt.where(CapabilityGuess.capability_id == capability_id)
    if product_id:
        stmt = stmt.where(Feature.product_id == product_id)
    return [_read(g, c, f, t) for g, c, f, t in (await session.execute(stmt)).all()]


def _read(guess, capability, feature, tech) -> GuessRead:
    return GuessRead.model_validate(
        {
            **{k: getattr(guess, k) for k in (
                "id", "seq", "created_at", "updated_at", "capability_id", "feature_id",
                "tech_id", "confidence", "basis", "fit",
            )},
            "capability_name": capability.name,
            "capability_slug": capability.slug,
            "subject_name": feature.name if feature else tech.name,
            "product_id": feature.product_id if feature else None,
        }
    )


async def _get(session: AsyncSession, guess_id: uuid.UUID) -> CapabilityGuess:
    guess = await session.get(CapabilityGuess, guess_id)
    if guess is None:
        raise HTTPException(404, "Guess not found")
    return guess


async def _one(session: AsyncSession, guess_id: uuid.UUID) -> GuessRead:
    rows = await list_guesses(session)
    return next(r for r in rows if r.id == guess_id)


async def record_guess(session: AsyncSession, data: GuessCreate) -> GuessRead:
    if await session.get(Capability, data.capability_id) is None:
        raise HTTPException(404, "Capability not found")
    if data.feature_id:
        feature = await session.get(Feature, data.feature_id)
        if feature is None:
            raise HTTPException(404, "Feature not found")
        confirmed = await session.scalar(
            select(FeatureCapability.id).where(
                FeatureCapability.feature_id == data.feature_id,
                FeatureCapability.capability_id == data.capability_id,
            )
        )
        subject = CapabilityGuess.feature_id == data.feature_id
    else:
        if await session.get(Technology, data.tech_id) is None:
            raise HTTPException(404, "Technology not found")
        confirmed = await session.scalar(
            select(TechSatisfaction.id).where(
                TechSatisfaction.tech_id == data.tech_id,
                TechSatisfaction.capability_id == data.capability_id,
            )
        )
        subject = CapabilityGuess.tech_id == data.tech_id
    if confirmed:
        # A guess never overrides a fact.
        raise HTTPException(409, "This link is already confirmed")
    guess = await session.scalar(
        select(CapabilityGuess).where(subject, CapabilityGuess.capability_id == data.capability_id)
    )
    if guess is None:
        guess = CapabilityGuess(**data.model_dump())
        session.add(guess)
    else:
        guess.confidence = data.confidence
        guess.basis = data.basis
        guess.fit = data.fit
    await session.commit()
    return await _one(session, guess.id)


async def confirm_guess(session: AsyncSession, guess_id: uuid.UUID, graph=None) -> None:
    guess = await _get(session, guess_id)
    if guess.feature_id:
        session.add(FeatureCapability(feature_id=guess.feature_id, capability_id=guess.capability_id))
    else:
        session.add(
            TechSatisfaction(
                tech_id=guess.tech_id,
                capability_id=guess.capability_id,
                fit=guess.fit or TechFit.partial,
                notes=guess.basis,
            )
        )
    feature_id = guess.feature_id
    await session.delete(guess)
    await session.commit()
    if graph is not None and feature_id:
        # The graph caches each feature's confirmed capability_ids.
        feature = await session.get(Feature, feature_id)
        await session.refresh(feature, ["capability_links"])
        graph.upsert_node(feature)


async def reject_guess(session: AsyncSession, guess_id: uuid.UUID) -> None:
    await session.delete(await _get(session, guess_id))
    await session.commit()
