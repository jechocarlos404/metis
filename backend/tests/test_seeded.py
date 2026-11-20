"""POST /api/products/{id}/seeded: the seed loaders' stamp of when a product's
map was last refreshed, and the stale-map health finding it feeds."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, authorize
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import Product
from app.models.enums import Surface
from app.services import capabilities as capability_service


@pytest_asyncio.fixture
async def client(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http


async def test_new_product_was_never_seeded(client):
    res = await client.post("/api/products", json={"name": "Can I Climb"})
    assert res.status_code == 201
    assert res.json()["seeded_at"] is None


async def test_stamping_sets_seeded_at_to_server_time(client):
    pid = (await client.post("/api/products", json={"name": "Can I Climb"})).json()["id"]
    before = datetime.now(timezone.utc) - timedelta(minutes=5)
    # A client timestamp in the body is ignored: the server's clock decides.
    res = await client.post(
        f"/api/products/{pid}/seeded", json={"seeded_at": "2001-01-01T00:00:00Z"}
    )
    assert res.status_code == 200
    stamped = datetime.fromisoformat(res.json()["seeded_at"])
    assert before <= stamped <= datetime.now(timezone.utc) + timedelta(minutes=5)
    listed = (await client.get("/api/products")).json()
    assert listed[0]["seeded_at"] == res.json()["seeded_at"]


async def test_stamping_an_unknown_product_is_404(client):
    res = await client.post(f"/api/products/{uuid.uuid4()}/seeded")
    assert res.status_code == 404


@pytest.mark.parametrize("surface", [Surface.api, Surface.mcp])
def test_agents_cannot_stamp(surface):
    viewer = Principal(sub="u", username="u", roles=["viewer"], surface=surface)
    with pytest.raises(HTTPException) as err:
        authorize("POST", viewer, f"/api/products/{uuid.uuid4()}/seeded")
    assert err.value.status_code == 403


def test_desktop_viewer_cannot_stamp():
    viewer = Principal(sub="u", username="u", roles=["viewer"], surface=Surface.desktop)
    with pytest.raises(HTTPException) as err:
        authorize("POST", viewer, f"/api/products/{uuid.uuid4()}/seeded")
    assert err.value.status_code == 403


def test_desktop_editor_can_stamp():
    editor = Principal(sub="u", username="u", roles=["editor"], surface=Surface.desktop)
    authorize("POST", editor, f"/api/products/{uuid.uuid4()}/seeded")  # does not raise


async def test_stale_map_finding_covers_ours_never_or_over_30_days(db):
    now = datetime.now(timezone.utc)
    async with db() as session:
        session.add_all(
            [
                Product(name="Never", slug="never"),
                Product(name="Old", slug="old", seeded_at=now - timedelta(days=31)),
                Product(name="Fresh", slug="fresh", seeded_at=now - timedelta(days=2)),
                Product(name="Theirs", slug="theirs", external=True),
            ]
        )
        await session.commit()
        findings = await capability_service.health(session)
    stale = {f.subject_name: f.detail for f in findings if f.kind == "stale_map"}
    assert set(stale) == {"Never", "Old"}
    assert stale["Never"] == "never imported from a seed file."
    assert "over 30 days ago" in stale["Old"]
