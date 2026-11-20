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
