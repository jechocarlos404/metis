"""External products — someone else's, known only from the outside — and
features whose capabilities are declared unknown. The inventory must keep
saying what *we* can do: external usage is shown, never counted as ours."""

import pytest
from fastapi import HTTPException

from app.models import CapabilityMaturity, Feature, Product, WorkStatus
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
async def test_what_we_are_still_building_stays_ours_to_explain(db):
    """Health skips what only someone else has, not what we're building: an
    unfinished feature of ours keeps it on our list, though it isn't ours yet."""
    async with db() as session:
        s = await estate(session)
        await feature_service.create_feature(
            session,
            FeatureCreate(
                name="Our leaderboards",
                product_id=s["ours"].id,
                capability_ids=[s["segments"].id],
                status=WorkStatus.in_progress,
            ),
        )
        findings = {(f.kind, f.subject_name) for f in await capability_service.health(session)}
        entry = {e.name: e for e in await capability_service.inventory(session)}["Segment leaderboards"]
    assert entry.ours is False
    assert ("unmotivated_capability", "Segment leaderboards") in findings


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


@pytest.mark.asyncio
async def test_how_much_of_an_external_product_we_could_build(db):
    async with db() as session:
        s = await estate(session)
        await feature_service.create_feature(
            session,
            FeatureCreate(
                name="Share routes",
                product_id=s["strava"].id,
                capability_ids=[s["sync"].id],
                unknown_capabilities=True,
            ),
        )
        score = await capability_service.product_coverage(session, s["strava"].id)

    assert score.product.name == "Strava"
    assert score.total_features == 4
    # Only a feature whose every capability is known AND ours counts. Share routes
    # needs only sync as far as we know — but "as far as we know" is not covered.
    assert score.buildable == ["Sync activities"]
    # The softer signal: every capability anyone named for Share routes is ours.
    # Beacon names none, so it never counts.
    assert score.partly == ["Share routes"]
    assert score.missing == ["Compete on segments"]
    assert score.missing_incomplete == []
    assert score.not_described == ["Beacon live tracking"]
    report = score.report
    assert (report.needed, report.existing) == (2, 1)
    assert report.missing == ["Segment leaderboards"]


@pytest.mark.asyncio
async def test_a_product_with_only_unknown_features_scores_zero(db):
    async with db() as session:
        p = await product(session, "Mystery", external=True)
        await feature_service.create_feature(
            session,
            FeatureCreate(name="Magic", product_id=p.id, capability_ids=[], unknown_capabilities=True),
        )
        score = await capability_service.product_coverage(session, p.id)
    assert score.report is None
    assert (score.total_features, score.buildable, score.not_described) == (1, [], ["Magic"])
    assert score.partly == score.missing == []


@pytest.mark.asyncio
async def test_a_product_score_partitions_its_features(db):
    """Every feature lands in exactly one group, decided by its own links —
    never by name, never by subtracting one list from another."""
    async with db() as session:
        s = await estate(session)
        strava = s["strava"]

        async def feature(name, caps, unknown):
            await feature_service.create_feature(
                session,
                FeatureCreate(
                    name=name,
                    product_id=strava.id,
                    capability_ids=[c.id for c in caps],
                    unknown_capabilities=unknown,
                ),
            )

        # estate() gave Strava: Sync activities (buildable), Compete on
        # segments (missing, complete list), Beacon live tracking (flagged, none).
        await feature("Share routes", [s["sync"]], True)  # partly
        # Flagged, and what is named exists only at Strava: missing, not "not described".
        await feature("Segment challenges", [s["segments"]], True)
        await feature("Synced segments", [s["sync"], s["segments"]], True)
        # Unflagged with no link: the write path refuses it (422), but a row like
        # this can exist, so the score must still place it.
        session.add(Feature(name="Legacy import", product_id=strava.id))
        await session.commit()
        score = await capability_service.product_coverage(session, strava.id)

    groups = [score.buildable, score.partly, score.missing, score.not_described]
    names = [n for g in groups for n in g]
    assert sum(map(len, groups)) == score.total_features == 7
    assert sorted(names) == sorted(set(names))  # disjoint
    assert score.buildable == ["Sync activities"]
    assert score.partly == ["Share routes"]
    assert score.missing == ["Compete on segments", "Segment challenges", "Synced segments"]
    assert score.missing_incomplete == ["Segment challenges", "Synced segments"]
    assert score.not_described == ["Beacon live tracking", "Legacy import"]


@pytest.mark.asyncio
async def test_what_to_build_next_is_ranked_and_the_closest_product_named(db):
    """Missing capabilities rank by how many features each alone would cover,
    then by how many need it; the closest products are ours, never the one
    scored, by how many of its named capabilities they have."""
    async with db() as session:
        names = ["Route planning", "Base maps", "Offline maps", "Turn by turn", "Heatmaps", "Beacon"]
        c = {n: await cap(session, n) for n in names}
        climb = await product(session, "Can I Climb")
        atlas = await product(session, "Atlas")
        rival = await product(session, "Rival", external=True)
        target = await product(session, "Target", external=True)

        async def feature(name, prod, caps):
            await feature_service.create_feature(
                session,
                FeatureCreate(
                    name=name,
                    product_id=prod.id,
                    capability_ids=[c[n].id for n in caps],
                    status=WorkStatus.done,
                ),
            )

        await feature("Plan", climb, ["Route planning", "Base maps"])
        await feature("Map", atlas, ["Base maps"])
        await feature("Offline", rival, ["Offline maps"])
        await feature("Plan offline", target, ["Route planning", "Offline maps"])
        await feature("Download an area", target, ["Base maps", "Offline maps"])
        await feature("Navigate", target, ["Route planning", "Turn by turn"])
        await feature("Navigate offline", target, ["Turn by turn", "Offline maps"])
        await feature("Heat", target, ["Heatmaps"])
        await feature("Beacon", target, ["Beacon", "Turn by turn"])
        score = await capability_service.product_coverage(session, target.id)
        own = await capability_service.product_coverage(session, climb.id)

    ranked = [(g.name, g.features, g.only_gap) for g in score.missing_capabilities]
    assert ranked == [
        ("Offline maps", 3, 2),
        ("Turn by turn", 3, 1),
        ("Heatmaps", 1, 1),
        ("Beacon", 1, 0),
    ]
    by_name = {g.name: g for g in score.missing_capabilities}
    assert by_name["Offline maps"].slug == "offline-maps"
    # Target has every one of these itself; elsewhere means some other product.
    assert [p.name for p in by_name["Offline maps"].elsewhere] == ["Rival"]
    assert by_name["Heatmaps"].elsewhere == []
    assert score.report.needed == 6
    assert [(p.product.name, p.capabilities) for p in score.closest_products] == [
        ("Can I Climb", 2),
        ("Atlas", 1),
    ]
    # Our own product lacks nothing, and is never its own closest product.
    assert own.missing_capabilities == []
    assert [(p.product.name, p.capabilities) for p in own.closest_products] == [("Atlas", 1)]

