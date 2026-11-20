"""The capability inventory: features of many products realizing shared
capabilities, and the two questions that make it pay — what do we already have
(inventory) and how much of a new product idea already exists (coverage)."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models import CapabilityMaturity, Feature, FeatureCapability, Product
from app.schemas.capability import CapabilityCreate, CoverageRequest
from app.schemas.feature import FeatureCreate, FeatureUpdate
from app.services import capabilities as capability_service
from app.services import features as feature_service


async def make_capability(session, name, maturity=CapabilityMaturity.planned, parent_id=None):
    return await capability_service.create_capability(
        session, CapabilityCreate(name=name, maturity=maturity, parent_id=parent_id)
    )


async def make_product(session, name):
    product = Product(name=name, slug=name.lower().replace(" ", "-"))
    session.add(product)
    await session.commit()
    return product


async def two_products(session):
    strava = await make_capability(session, "Strava import", CapabilityMaturity.ga)
    elevation = await make_capability(session, "Elevation data", CapabilityMaturity.beta)
    physics = await make_capability(session, "Physics model", CapabilityMaturity.alpha)
    planner = await make_capability(session, "Route planner")
    climb = await make_product(session, "Can I Climb")
    cycling = await make_product(session, "Cycling Tool")
    await feature_service.create_feature(
        session,
        FeatureCreate(
            name="Estimate climb power",
            product_id=climb.id,
            capability_ids=[physics.id, elevation.id, strava.id],
        ),
    )
    await feature_service.create_feature(
        session,
        FeatureCreate(
            name="Show ride summary",
            product_id=cycling.id,
            capability_ids=[strava.id, elevation.id],
        ),
    )
    return {
        "strava": strava,
        "elevation": elevation,
        "physics": physics,
        "planner": planner,
        "climb": climb,
        "cycling": cycling,
    }


@pytest.mark.asyncio
async def test_feature_realizes_several_capabilities(db):
    async with db() as session:
        s = await two_products(session)
        feature = await session.scalar(select(Feature).where(Feature.name == "Estimate climb power"))
        links = set(
            await session.scalars(
                select(FeatureCapability.capability_id).where(
                    FeatureCapability.feature_id == feature.id
                )
            )
        )
        assert links == {s["physics"].id, s["elevation"].id, s["strava"].id}
        assert feature.product_id == s["climb"].id


@pytest.mark.asyncio
async def test_feature_must_realize_at_least_one_capability(db):
    async with db() as session:
        with pytest.raises(HTTPException) as err:
            await feature_service.create_feature(
                session, FeatureCreate(name="unanchored", capability_ids=[])
            )
        assert err.value.status_code == 422

        cap = await make_capability(session, "Anything")
        feature = await feature_service.create_feature(
            session, FeatureCreate(name="anchored", capability_ids=[cap.id])
        )
        with pytest.raises(HTTPException) as err:
            await feature_service.update_feature(
                session, feature.id, FeatureUpdate(capability_ids=[])
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_update_replaces_the_capability_set(db):
    async with db() as session:
        s = await two_products(session)
        feature = await session.scalar(select(Feature).where(Feature.name == "Show ride summary"))
        feature = await feature_service.update_feature(
            session, feature.id, FeatureUpdate(capability_ids=[s["planner"].id])
        )
        assert feature.capability_ids == [s["planner"].id]


@pytest.mark.asyncio
async def test_inventory_ranks_capabilities_by_product_reuse(db):
    async with db() as session:
        await two_products(session)
        inventory = await capability_service.inventory(session)

    by_name = {entry.name: entry for entry in inventory}
    assert [p.name for p in by_name["Strava import"].products] == ["Can I Climb", "Cycling Tool"]
    assert by_name["Strava import"].features == 2
    assert [p.name for p in by_name["Physics model"].products] == ["Can I Climb"]
    assert by_name["Route planner"].products == []
    # Most-reused first; the unused capability sinks to the bottom.
    assert inventory[0].name in {"Elevation data", "Strava import"}
    assert inventory[-1].name == "Route planner"


@pytest.mark.asyncio
async def test_coverage_of_a_product_idea(db):
    async with db() as session:
        await two_products(session)
        report = await capability_service.coverage(
            session,
            CoverageRequest.model_validate(
                {
                    "features": [
                        {
                            "name": "Predict climb time from weather",
                            "capabilities": ["strava import", "Physics model", "Weather forecast"],
                        },
                        {"name": "Import past rides", "capabilities": ["Strava import"]},
                    ]
                }
            ),
        )

    predict, import_rides = report.features
    assert (predict.existing, predict.total) == (2, 3)
    assert (import_rides.existing, import_rides.total) == (1, 1)

    strava_need = predict.capabilities[0]
    assert strava_need.match is not None and strava_need.match.name == "Strava import"
    assert strava_need.match.maturity == CapabilityMaturity.ga
    assert [p.name for p in strava_need.match.products] == ["Can I Climb", "Cycling Tool"]
    assert predict.capabilities[2].match is None

    # Summary counts distinct needs, not mentions.
    assert (report.needed, report.existing) == (3, 2)
    assert report.missing == ["Weather forecast"]


@pytest.mark.asyncio
async def test_a_capability_nobody_builds_is_not_ours(db):
    """Naming a capability is not having it: with no feature realizing it
    anywhere, it is neither ours nor known from an external product."""
    async with db() as session:
        await two_products(session)
        report = await capability_service.coverage(
            session,
            CoverageRequest.model_validate(
                {"features": [{"name": "Plan a route", "capabilities": ["Route planner"]}]}
            ),
        )
        inventory = {e.name: e for e in await capability_service.inventory(session)}
        health = await capability_service.health(session)

    match = report.features[0].capabilities[0].match
    assert match is not None and match.name == "Route planner"
    assert match.ours is False
    assert (match.products, match.external_products) == ([], [])
    assert (report.needed, report.existing) == (1, 0)
    assert report.missing == ["Route planner"]
    assert inventory["Route planner"].ours is False
    # Still ours to explain: planned, and nothing builds toward it.
    assert any(
        f.kind == "aspirational_gap" and f.subject_name == "Route planner" for f in health
    )


@pytest.mark.asyncio
async def test_coverage_suggests_near_names_instead_of_guessing(db):
    async with db() as session:
        await make_capability(session, "Authentication")
        report = await capability_service.coverage(
            session,
            CoverageRequest.model_validate(
                {"features": [{"name": "Sign in", "capabilities": ["Authentication service"]}]}
            ),
        )
    need = report.features[0].capabilities[0]
    assert need.match is None  # never silently fuzzy-matched
    assert [c.name for c in need.candidates] == ["Authentication"]


@pytest.mark.asyncio
async def test_deleting_a_used_capability_is_refused(db):
    async with db() as session:
        s = await two_products(session)
        with pytest.raises(HTTPException) as err:
            await capability_service.delete_capability(session, s["strava"].id)
        assert err.value.status_code == 409


@pytest.mark.asyncio
async def test_scope_counts_a_shared_feature_once_per_capability(db):
    async with db() as session:
        s = await two_products(session)
        strava_scope = await capability_service.scope(session, s["strava"].id)
        physics_scope = await capability_service.scope(session, s["physics"].id)
    assert {f.name for f in strava_scope} == {"Estimate climb power", "Show ride summary"}
    assert {f.name for f in physics_scope} == {"Estimate climb power"}


@pytest.mark.asyncio
async def test_coverage_suggests_the_full_name_for_an_abbreviation(db):
    async with db() as session:
        await make_capability(session, "Authentication")
        report = await capability_service.coverage(
            session,
            CoverageRequest.model_validate(
                {"features": [{"name": "Sign in", "capabilities": ["Auth"]}]}
            ),
        )
    need = report.features[0].capabilities[0]
    assert need.match is None
    assert [c.name for c in need.candidates] == ["Authentication"]


@pytest.mark.asyncio
async def test_agent_tool_links_exact_names_only(db):
    """The agent's create_feature never substring-matches a capability: a near
    name fails with candidates instead of silently linking the wrong one."""
    from app.agents import tools
    from app.agents.tools import ToolContext, ToolError

    async with db() as session:
        auth = await make_capability(session, "Authentication")
        ctx = ToolContext(session=session)
        with pytest.raises(ToolError) as err:
            await tools.create_feature(ctx, name="Sign in", capabilities=["Auth"])
        assert "`Authentication`" in str(err.value)

        await tools.create_feature(ctx, name="Sign in", capabilities=["authentication"])
        feature = await session.scalar(select(Feature).where(Feature.name == "Sign in"))
        assert feature.capability_ids == [auth.id]
