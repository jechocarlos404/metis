"""DELETE /api/products/{id}: a product's features go with it. Left behind
without a product they would count as ours, so deleting someone else's
product would make its capabilities ours."""

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import Capability, CapabilityMaturity, Feature, Product, WorkStatus
from app.schemas.capability import CapabilityCreate
from app.schemas.feature import FeatureCreate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.graph_service import FeatureGraph


@pytest_asyncio.fixture
async def app_graph(db):
    app = create_app()
    app.state.graph = FeatureGraph()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, app.state.graph


async def estate(session, graph):
    probe = await capability_service.create_capability(
        session, CapabilityCreate(name="Probe cap", maturity=CapabilityMaturity.ga)
    )
    climb = await capability_service.create_capability(
        session, CapabilityCreate(name="Route climbs", maturity=CapabilityMaturity.ga)
    )
    ours = Product(name="Can I Climb", slug="can-i-climb")
    strava = Product(name="Strava", slug="strava", external=True)
    session.add_all([ours, strava])
    await session.commit()

    async def feature(name, prod, cap):
        return await feature_service.create_feature(
            session,
            FeatureCreate(name=name, product_id=prod.id, capability_ids=[cap.id], status=WorkStatus.done),
            graph,
        )

    theirs = await feature("Probe feature", strava, probe)
    mine = await feature("Plan a climb", ours, climb)
    return {"probe": probe, "ours": ours, "strava": strava, "theirs": theirs, "mine": mine}


async def ours_by_name(session):
    return {e.name: e.ours for e in await capability_service.inventory(session)}


async def test_deleting_a_product_deletes_its_features_not_detaches_them(db, app_graph):
    client, graph = app_graph
    async with db() as session:
        e = await estate(session, graph)
        assert (await ours_by_name(session))["Probe cap"] is False
        assert graph.node_count() == 2

    res = await client.delete(f"/api/products/{e['strava'].id}")
    assert res.status_code == 204

    async with db() as session:
        # Nothing is left without a product, so nothing turned into ours.
        assert await session.scalar(select(func.count()).where(Feature.product_id.is_(None))) == 0
        assert await session.get(Feature, e["theirs"].id) is None
        assert (await ours_by_name(session))["Probe cap"] is False
        # Capabilities stay; the other product's feature is untouched.
        assert await session.get(Capability, e["probe"].id) is not None
        assert await session.get(Feature, e["mine"].id) is not None
    # The graph stops serving the deleted feature.
    assert graph.node_count() == 1


async def test_deleting_an_unknown_product_is_404(app_graph):
    client, _ = app_graph
    res = await client.delete("/api/products/00000000-0000-0000-0000-000000000000")
    assert res.status_code == 404


async def test_a_product_delete_names_everything_it_deletes(app_graph, db):
    """The confirm named only the features (B47). `deletes` names every row
    the delete takes, by table, from the closure the delete follows, and the
    delete then removes exactly those."""
    from app.models import (
        Epic, FeatureCapability, ProductDecomposition, StackSlot, Story, TechStack,
    )
    from app.models.enums import DocStatus, TechLayer

    http, graph = app_graph
    async with db() as session:
        cap = await capability_service.create_capability(session, CapabilityCreate(name="Trail notes"))
        trail = Product(name="Trail Notes", slug="trail-notes")
        session.add(trail)
        await session.commit()
        feature = await feature_service.create_feature(
            session, FeatureCreate(name="Sync notes later", product_id=trail.id, capability_ids=[cap.id]), graph
        )
        plan = ProductDecomposition(product_id=trail.id, version=1, document={}, status=DocStatus.approved)
        stack = TechStack(name="Trail stack", product_id=trail.id)
        session.add_all([plan, stack])
        await session.flush()
        epic = Epic(product_id=trail.id, decomposition_id=plan.id, title="Offline epic")
        session.add_all([epic, StackSlot(stack_id=stack.id, layer=TechLayer.data, role="note store")])
        await session.flush()
        session.add(Story(epic_id=epic.id, feature_id=feature.id, title="Sync story"))
        await session.commit()
        trail_id = trail.id

    res = await http.get(f"/api/products/{trail_id}/deletes")
    assert res.status_code == 200
    said = {t["table"]: (t["count"], t["names"]) for t in res.json()}
    assert said == {
        "features": (1, ["Sync notes later"]),
        "feature_capabilities": (1, ["Sync notes later → Trail notes"]),
        "product_decompositions": (1, ["version 1"]),
        "epics": (1, ["Offline epic"]),
        "stories": (1, ["Sync story"]),
        "tech_stacks": (1, ["Trail stack"]),
        "stack_slots": (1, ["data::note store"]),
    }
    import uuid as _uuid
    assert (await http.get(f"/api/products/{_uuid.uuid4()}/deletes")).status_code == 404

    assert (await http.delete(f"/api/products/{trail_id}")).status_code == 204
    async with db() as session:
        for model in (Product, Feature, FeatureCapability, ProductDecomposition, Epic, Story, TechStack, StackSlot):
            assert await session.scalar(select(func.count()).select_from(model)) == 0, model
        assert await session.scalar(select(func.count()).select_from(Capability)) == 1
