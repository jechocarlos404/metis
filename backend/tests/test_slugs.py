"""Slug identity — the address the API and MCP surfaces quote back.

A slug has to outlive the name it came from, or every href and resource URI
ever logged stops resolving.
"""

import pytest
from fastapi import HTTPException

from app.models import Capability, Product
from app.schemas.capability import CapabilityCreate, CapabilityUpdate
from app.services import capabilities as capability_service
from app.services.slugs import slugify, unique_slug


def test_slugify_is_lowercase_kebab():
    assert slugify("Semantic Search") == "semantic-search"
    assert slugify("  PM Export — ticket delivery  ") == "pm-export-ticket-delivery"
    assert slugify("OAuth 2.1") == "oauth-2-1"
    assert slugify("!!!") == ""


@pytest.mark.asyncio
async def test_slug_derived_from_name_and_deduplicated(db):
    async with db() as session:
        first = await capability_service.create_capability(
            session, CapabilityCreate(name="Semantic search")
        )
        second = await capability_service.create_capability(
            session, CapabilityCreate(name="Semantic Search")
        )
        assert first.slug == "semantic-search"
        assert second.slug == "semantic-search-2"


@pytest.mark.asyncio
async def test_rename_does_not_move_the_slug(db):
    """The whole point: a link quoted in a transcript last week still resolves."""
    async with db() as session:
        capability = await capability_service.create_capability(
            session, CapabilityCreate(name="Semantic search")
        )
        renamed = await capability_service.update_capability(
            session, capability.id, CapabilityUpdate(name="Vector retrieval")
        )
        assert renamed.name == "Vector retrieval"
        assert renamed.slug == "semantic-search"


@pytest.mark.asyncio
async def test_explicit_slug_is_pinned_and_collisions_are_errors(db):
    """An explicit slug was chosen on purpose — suffixing it silently would
    hand the caller an address they did not ask for."""
    async with db() as session:
        await capability_service.create_capability(
            session, CapabilityCreate(name="Semantic search", slug="vector-search")
        )
        with pytest.raises(HTTPException) as err:
            await capability_service.create_capability(
                session, CapabilityCreate(name="Anything", slug="vector-search")
            )
        assert err.value.status_code == 409

        with pytest.raises(HTTPException) as err:
            await capability_service.create_capability(
                session, CapabilityCreate(name="Anything", slug="Not A Slug")
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_unnameable_subject_needs_an_explicit_slug(db):
    async with db() as session:
        with pytest.raises(HTTPException) as err:
            await unique_slug(session, Capability, "!!!")
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_products_and_capabilities_have_separate_namespaces(db):
    async with db() as session:
        capability = await capability_service.create_capability(
            session, CapabilityCreate(name="metis")
        )
        slug = await unique_slug(session, Product, "metis")
        assert capability.slug == slug == "metis"
