"""Stable, human-readable identity for the nodes the API addresses by name.

A slug is what makes an answer greppable across surfaces: a screenshot, a log
line and a chat transcript all say `semantic-search`, so they can be compared.
That only works if the slug outlives the name it was derived from — so it is
generated once, on create, and a rename never touches it. Changing one is a
deliberate act, the same rule `technologies.slug` already lives under.
"""

import re
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    """Lowercase kebab. Returns '' when nothing survives — callers fall back to
    the sequence number rather than inventing a name."""
    return _NON_ALNUM.sub("-", value.strip().lower()).strip("-")


def valid_slug(name: str, requested: str | None = None) -> str:
    """The slug for `name`, or the one the caller asked for once it is checked
    to be a slug. Says nothing about whether it is free."""
    base = slugify(requested or name)
    if requested is not None and base != requested:
        raise HTTPException(
            422, f"`{requested}` is not a slug — lowercase, digits and dashes only"
        )
    if not base:
        raise HTTPException(422, "Name yields an empty slug — give one explicitly")
    return base


async def unique_slug(
    session: AsyncSession,
    model,
    name: str,
    requested: str | None = None,
    exclude_id: uuid.UUID | None = None,
) -> str:
    """Derive a free slug for `name`, or validate the one the caller asked for.

    An explicit request that collides is an error, not something to silently
    suffix — the caller named it on purpose. A derived one gets `-2`, `-3` …
    appended, because two products may legitimately share a name. Capabilities
    don't use this: a second one by the same name is refused instead."""
    base = valid_slug(name, requested)

    async def taken(candidate: str) -> bool:
        stmt = select(model.id).where(model.slug == candidate)
        if exclude_id is not None:
            stmt = stmt.where(model.id != exclude_id)
        return await session.scalar(stmt) is not None

    if not await taken(base):
        return base
    if requested is not None:
        raise HTTPException(409, f"Slug `{base}` is already taken")
    suffix = 2
    while await taken(f"{base}-{suffix}"):
        suffix += 1
    return f"{base}-{suffix}"


async def by_slug(session: AsyncSession, model, slug: str, label: str):
    """Slug lookup for the question endpoints, which address nodes by name."""
    found = await session.scalar(select(model).where(model.slug == slug))
    if found is None:
        raise HTTPException(404, f"{label} not found")
    return found
