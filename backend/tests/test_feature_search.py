"""Feature search: the directory counts and filters what this returns, so by
default it returns every match, never a silent top 20."""

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import Product
from app.schemas.feature import FeatureCreate
from app.services import features as feature_service


@pytest_asyncio.fixture
async def client(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield db, http


async def test_search_returns_every_match_unless_limited(client):
    db, http = client
    async with db() as s:
        product = Product(name="App", slug="app")
        s.add(product)
        await s.commit()
        for i in range(25):
            await feature_service.create_feature(
                s, FeatureCreate(name=f"Rate skill {i}", product_id=product.id, unknown_capabilities=True)
            )
        await feature_service.create_feature(
            s, FeatureCreate(name="Export invoices", product_id=product.id, unknown_capabilities=True)
        )

    res = await http.get("/api/features/search", params={"q": "skill"})
    assert res.status_code == 200, res.text
    assert len(res.json()) == 25

    res = await http.get("/api/features/search", params={"q": "skill", "limit": 5})
    assert len(res.json()) == 5
