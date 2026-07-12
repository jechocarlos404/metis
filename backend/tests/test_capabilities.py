"""Capability map service tests — forest invariants, bridge traversals
(scope/rollup/why), health findings, and the feature-side REALIZES guard."""

import pytest
from fastapi import HTTPException

from app.models import CapabilityMaturity, Goal, GoalType, Product, WorkStatus
from app.schemas.capability import CapabilityCreate, CapabilityUpdate
from app.schemas.feature import EdgeCreate, FeatureCreate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.graph_service import FeatureGraph


async def make_capability(session, name, parent_id=None, maturity=CapabilityMaturity.planned):
    return await capability_service.create_capability(
        session, CapabilityCreate(name=name, parent_id=parent_id, maturity=maturity)
    )


async def make_feature(session, name, capability_id, status=WorkStatus.pending, graph=None):
    return await feature_service.create_feature(
        session,
        FeatureCreate(name=name, capability_id=capability_id, status=status),
        graph,
    )


@pytest.mark.asyncio
async def test_forest_cycle_rejected(db):
    async with db() as session:
        root = await make_capability(session, "root")
        child = await make_capability(session, "child", parent_id=root.id)
        with pytest.raises(HTTPException) as err:
            await capability_service.update_capability(
                session, root.id, CapabilityUpdate(parent_id=child.id)
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_feature_requires_real_capability(db):
    import uuid

    async with db() as session:
        with pytest.raises(HTTPException) as err:
            await make_feature(session, "orphan work", uuid.uuid4())
        assert err.value.status_code == 404


@pytest.mark.asyncio
async def test_scope_and_rollup_cover_submap(db):
    async with db() as session:
        root = await make_capability(session, "feature intelligence")
        search = await make_capability(session, "feature search", parent_id=root.id)
        graphc = await make_capability(session, "feature graph", parent_id=root.id)
        await make_feature(session, "rank search results", search.id, WorkStatus.done)
        await make_feature(session, "traverse dependencies", graphc.id, WorkStatus.in_progress)
        await make_feature(session, "draw the graph", graphc.id)

        rollup = await capability_service.rollup(session, root.id)
        assert (rollup.total, rollup.done, rollup.in_progress, rollup.pending) == (3, 1, 1, 1)

        # rollup at a leaf sees only its own scope
        leaf = await capability_service.rollup(session, search.id)
        assert (leaf.total, leaf.done) == (1, 1)

        tree = await capability_service.capability_map(session)
        assert len(tree) == 1 and tree[0].rollup.total == 3
        assert {c.name for c in tree[0].children} == {"feature search", "feature graph"}


@pytest.mark.asyncio
async def test_delete_capability_with_features_conflicts(db):
    async with db() as session:
        capability = await make_capability(session, "ticket export")
        await make_feature(session, "add jira backend", capability.id)
        with pytest.raises(HTTPException) as err:
            await capability_service.delete_capability(session, capability.id)
        assert err.value.status_code == 409


@pytest.mark.asyncio
async def test_why_chain_reaches_org_intent(db):
    async with db() as session:
        org = Goal(goal_type=GoalType.org, title="Be the default tool")
        session.add(org)
        await session.flush()
        pg = Goal(goal_type=GoalType.product, parent_goal_id=org.id, title="Ship export")
        session.add(pg)
        await session.commit()

        root = await make_capability(session, "ticket export")
        sub = await make_capability(session, "jira export", parent_id=root.id)
        await capability_service.add_motivation(session, root.id, pg.id)
        feature = await make_feature(session, "round-trip jira status", sub.id)

        chain = (await capability_service.why(session, feature)).chain
        kinds = [(step.kind, step.relation) for step in chain]
        assert kinds[0] == ("feature", "")
        assert ("capability", "REALIZES") in kinds
        assert ("capability", "PART_OF") in kinds
        assert ("goal", "MOTIVATES") in kinds
        assert ("goal", "parent") in kinds  # climbed to the org goal
        assert chain[-1].name == "Be the default tool"


@pytest.mark.asyncio
async def test_product_attribution_follows_containment(db):
    async with db() as session:
        root = await make_capability(session, "feature intelligence")
        child = await make_capability(session, "feature search", parent_id=root.id)
        stray = await make_capability(session, "ticket export")
        pg = Goal(goal_type=GoalType.product, title="Ship search")
        session.add(pg)
        await session.flush()
        spec = Product(name="Search Spec", goal_id=pg.id)
        session.add(spec)
        await session.commit()
        await capability_service.add_motivation(session, root.id, pg.id)

        attribution = await capability_service.product_attribution(session)
        assert attribution[str(root.id)] == [str(spec.id)]
        # children inherit attribution through PART_OF, like why() does
        assert attribution[str(child.id)] == [str(spec.id)]
        assert attribution[str(stray.id)] == []


@pytest.mark.asyncio
async def test_health_findings(db):
    async with db() as session:
        # aspirational gap: planned + empty scope
        await make_capability(session, "notion export")
        # stable shipped capability: GA + empty scope must NOT be a finding
        ga = await make_capability(session, "search", maturity=CapabilityMaturity.ga)
        # empty intent: product goal motivating nothing
        pg = Goal(goal_type=GoalType.product, title="Every ticket fits one session")
        session.add(pg)
        await session.commit()

        findings = await capability_service.health(session)
        by_kind = {}
        for finding in findings:
            by_kind.setdefault(finding.kind, []).append(finding.subject_name)
        assert "notion export" in by_kind["aspirational_gap"]
        assert "search" not in by_kind.get("aspirational_gap", [])
        assert "Every ticket fits one session" in by_kind["empty_intent"]


@pytest.mark.asyncio
async def test_mvp_cut_expands_capability_targets(db):
    async with db() as session:
        graph = FeatureGraph(sessionmaker=None)
        root = await make_capability(session, "ticket export")
        sub = await make_capability(session, "jira export", parent_id=root.id)
        auth = await make_capability(session, "authentication")
        reporting = await make_capability(session, "reporting")
        login = await make_feature(session, "add login", auth.id, graph=graph)
        export = await make_feature(session, "export to jira", sub.id, graph=graph)
        await make_feature(session, "draw charts", reporting.id, graph=graph)
        await feature_service.create_edge(
            session, EdgeCreate(src_id=export.id, dst_id=login.id, kind="DEPENDS_ON"), graph
        )

        # target the root capability: expands through the submap to its features
        cut = await capability_service.mvp_cut(session, graph, [], [root.id])
        assert [f["name"] for f in cut["essential"]] == ["add login", "export to jira"]
        assert cut["essential"][0]["is_target"] is False  # pulled in as prerequisite
        assert cut["essential"][1]["is_target"] is True
        assert [f["name"] for f in cut["deferrable"]] == ["draw charts"]
        assert cut["targets"] == [str(export.id)]

        by_name = {c["name"]: c for c in cut["capabilities"]}
        assert by_name["jira export"]["essential"] is True
        assert (by_name["authentication"]["required"], by_name["authentication"]["total"]) == (1, 1)
        assert by_name["reporting"]["essential"] is False
        # essential capabilities sort ahead of deferrable ones
        assert [c["essential"] for c in cut["capabilities"]] == [True, True, False]


@pytest.mark.asyncio
async def test_mvp_cut_rejects_featureless_targets(db):
    async with db() as session:
        graph = FeatureGraph(sessionmaker=None)
        empty = await make_capability(session, "notion export")
        with pytest.raises(HTTPException) as err:
            await capability_service.mvp_cut(session, graph, [], [empty.id])
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_edge_write_rejected_on_cycle(db):
    async with db() as session:
        capability = await make_capability(session, "export")
        graph = FeatureGraph(sessionmaker=None)
        a = await make_feature(session, "a", capability.id, graph=graph)
        b = await make_feature(session, "b", capability.id, graph=graph)
        await feature_service.create_edge(
            session, EdgeCreate(src_id=a.id, dst_id=b.id, kind="DEPENDS_ON"), graph
        )
        with pytest.raises(HTTPException) as err:
            await feature_service.create_edge(
                session, EdgeCreate(src_id=b.id, dst_id=a.id, kind="DEPENDS_ON"), graph
            )
        assert err.value.status_code == 422
        # the reverse BLOCKS direction is the same precedence edge: also rejected
        with pytest.raises(HTTPException) as err:
            await feature_service.create_edge(
                session, EdgeCreate(src_id=a.id, dst_id=b.id, kind="BLOCKS"), graph
            )
        assert err.value.status_code == 422
