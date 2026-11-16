"""External products — someone else's, known only from the outside — and
features whose capabilities are declared unknown. The inventory must keep
saying what *we* can do: external usage is shown, never counted as ours."""

import pytest
from fastapi import HTTPException

from app.models import CapabilityMaturity, Product, WorkStatus
from app.schemas.capability import CapabilityCreate, CoverageRequest
from app.schemas.feature import FeatureCreate, FeatureUpdate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.graph_service import FeatureGraph


async def cap(session, name, maturity=CapabilityMaturity.planned):
    return await capability_service.create_capability(
        session, CapabilityCreate(name=name, maturity=maturity)
    )


async def product(session, name, external=False):
    row = Product(name=name, slug=name.lower().replace(" ", "-"), external=external)
    session.add(row)
    await session.commit()
    return row


async def estate(session, graph=None):
    sync = await cap(session, "Activity sync", CapabilityMaturity.ga)
    # Only Strava (external) needs this. Its maturity was guessed by whoever
    # described Strava — it says nothing about us.
    segments = await cap(session, "Segment leaderboards", CapabilityMaturity.ga)
    ours = await product(session, "Can I Climb")
    strava = await product(session, "Strava", external=True)

    async def feature(name, prod, caps, status=WorkStatus.pending, unknown=False):
        return await feature_service.create_feature(
            session,
            FeatureCreate(
                name=name,
                product_id=prod.id,
                capability_ids=[c.id for c in caps],
                status=status,
                unknown_capabilities=unknown,
            ),
            graph,
        )

    await feature("Import rides", ours, [sync], WorkStatus.done)
    await feature("Sync activities", strava, [sync], WorkStatus.done)
    await feature("Compete on segments", strava, [segments])
    await feature("Beacon live tracking", strava, [], unknown=True)
    return {"sync": sync, "segments": segments, "ours": ours, "strava": strava}


@pytest.mark.asyncio
async def test_unknown_capabilities_must_be_declared(db):
    async with db() as session:
        with pytest.raises(HTTPException) as err:
            await feature_service.create_feature(session, FeatureCreate(name="x", capability_ids=[]))
        assert err.value.status_code == 422

        f = await feature_service.create_feature(
            session, FeatureCreate(name="x", capability_ids=[], unknown_capabilities=True)
        )
        assert f.capability_ids == []
        # Clearing the declaration while nothing is linked is the same orphan.
        with pytest.raises(HTTPException) as err:
            await feature_service.update_feature(
                session, f.id, FeatureUpdate(unknown_capabilities=False)
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_declared_unknown_is_not_a_health_finding(db):
    async with db() as session:
        await estate(session)
        findings = await capability_service.health(session)
    assert not [f for f in findings if f.kind == "unlinked_feature"]


@pytest.mark.asyncio
async def test_inventory_separates_ours_from_external(db):
    async with db() as session:
        await estate(session)
        inventory = await capability_service.inventory(session)
    by_name = {e.name: e for e in inventory}

    sync = by_name["Activity sync"]
    assert sync.ours is True
    assert [p.name for p in sync.products] == ["Can I Climb"]
    assert [p.name for p in sync.external_products] == ["Strava"]
    assert sync.features == 1  # our features only

    segments = by_name["Segment leaderboards"]
    assert segments.ours is False
    assert segments.products == []
    assert [p.name for p in segments.external_products] == ["Strava"]
    # What we can already do comes first; external-only knowledge sinks.
    assert inventory[-1].name == "Segment leaderboards"


@pytest.mark.asyncio
async def test_coverage_counts_only_what_we_built(db):
    async with db() as session:
        await estate(session)
        report = await capability_service.coverage(
            session,
            CoverageRequest.model_validate(
                {"features": [{"name": "Club rides", "capabilities": ["Activity sync", "Segment leaderboards"]}]}
            ),
        )
    sync_need, seg_need = report.features[0].capabilities
    assert sync_need.match.ours is True
    assert seg_need.match is not None and seg_need.match.ours is False
    assert [p.name for p in seg_need.match.external_products] == ["Strava"]
    # Segment leaderboards is known (Strava has it) but not ours; its "ga"
    # is someone else's maturity and must not count as proven.
    assert (report.needed, report.existing, report.mature) == (2, 1, 1)
    assert report.missing == ["Segment leaderboards"]
    assert report.features[0].existing == 1


@pytest.mark.asyncio
async def test_external_features_are_not_our_work(db):
    graph = FeatureGraph(sessionmaker=None)
    async with db() as session:
        s = await estate(session, graph)
        ready = {f["name"] for f in graph.ready_set()}
        rollup = await capability_service.rollup(session, s["sync"].id)
    assert "Compete on segments" not in ready
    assert "Beacon live tracking" not in ready
    assert (rollup.total, rollup.done) == (1, 1)  # Strava's sync is not our progress


@pytest.mark.asyncio
async def test_flipping_a_product_external_refreshes_the_graph(db):
    graph = FeatureGraph(sessionmaker=None)
    async with db() as session:
        p = await product(session, "Side project")
        c = await cap(session, "Thing")
        await feature_service.create_feature(
            session, FeatureCreate(name="Do thing", product_id=p.id, capability_ids=[c.id]), graph
        )
        assert "Do thing" in {f["name"] for f in graph.ready_set()}
        p.external = True
        await session.commit()
        await feature_service.refresh_product_features(session, p.id, graph)
    assert "Do thing" not in {f["name"] for f in graph.ready_set()}
