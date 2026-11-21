"""Slug identity — the address the API and MCP surfaces quote back.

A slug has to outlive the name it came from, or every href and resource URI
ever logged stops resolving.
"""

import pytest
from fastapi import HTTPException

from app.models import Capability, Product
from app.schemas.capability import CapabilityCreate, CapabilityUpdate, CoverageRequest
from app.services import capabilities as capability_service
from app.services.slugs import slugify, unique_slug
from tests.test_plugin_scripts import SLUG_VECTORS


def test_slugify_is_lowercase_kebab():
    assert slugify("Semantic Search") == "semantic-search"
    assert slugify("  PM Export — ticket delivery  ") == "pm-export-ticket-delivery"
    assert slugify("OAuth 2.1") == "oauth-2-1"
    assert slugify("!!!") == ""


@pytest.mark.parametrize("name,slug", SLUG_VECTORS)
def test_slugify_folds_accents_as_every_copy_does(name, slug):
    """"Café" and "Cafe" are one name. The plugin's copies and the app's are
    held to the same list in test_plugin_scripts."""
    assert slugify(name) == slug


@pytest.mark.asyncio
async def test_a_slug_stored_before_the_fold_is_still_found_by_its_name(db):
    """Stored slugs are never re-derived: "Résumé Parsing" keeps the
    `r-sum-parsing` it got before accents folded, and a lookup by name finds
    it through the slug its name derives now, as it finds a renamed one."""
    async with db() as session:
        session.add(Capability(name="Résumé Parsing", slug="r-sum-parsing"))
        await session.commit()
        for name in ("Résumé Parsing", "Resume Parsing", "r-sum-parsing"):
            report = await capability_service.coverage(
                session, CoverageRequest(features=[{"name": "Import a CV", "capabilities": [name]}])
            )
            match = report.features[0].capabilities[0].match
            assert match is not None and match.slug == "r-sum-parsing", name


@pytest.mark.asyncio
async def test_slug_derived_from_name_and_deduplicated(db):
    """Products may share a name. Capabilities may not — see
    test_capability_identity."""
    async with db() as session:
        first = await unique_slug(session, Product, "Semantic search")
        session.add(Product(name="Semantic search", slug=first))
        await session.flush()
        second = await unique_slug(session, Product, "Semantic Search")
        assert first == "semantic-search"
        assert second == "semantic-search-2"


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
