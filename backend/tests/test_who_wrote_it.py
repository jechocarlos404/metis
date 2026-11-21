"""A write records who made it: the signed-in person, never what the client
claims. With auth off (local dev) the client's value or its default stands.
The access log reaches stderr, since nothing else configures logging."""

import logging

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, current_user
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models.enums import Surface

EDITOR = Principal(
    sub="u-1", username="editor", email="editor@metis.local", roles=["editor"],
    surface=Surface.desktop,
)


@pytest_asyncio.fixture
async def app(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    return app


async def _writes(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        product = (await http.post("/api/products", json={"name": "Notes"})).json()
        prd = await http.post(
            f"/api/products/{product['id']}/decompositions",
            json={"document": {"summary": "s"}, "created_by": "someone-else"},
        )
        strategy = await http.post(
            f"/api/products/{product['id']}/strategies", json={"created_by": "someone-else"}
        )
        default = await http.post(f"/api/products/{product['id']}/strategies", json={})
    assert prd.status_code == strategy.status_code == default.status_code == 201
    return prd.json()["created_by"], strategy.json()["created_by"], default.json()["created_by"]


async def test_with_auth_on_the_signed_in_person_is_recorded_over_the_claim(app):
    app.dependency_overrides[current_user] = lambda: EDITOR
    assert await _writes(app) == ("editor", "editor", "editor")


async def test_a_token_without_a_username_records_the_email(app):
    app.dependency_overrides[current_user] = lambda: Principal(
        sub="u-2", username="", email="e@metis.local", roles=["editor"], surface=Surface.desktop
    )
    assert await _writes(app) == ("e@metis.local",) * 3


async def test_with_auth_off_the_claim_and_default_stand(app):
    assert await _writes(app) == ("someone-else", "someone-else", "user")


def test_the_access_log_is_emitted_at_info():
    create_app()
    log = logging.getLogger("metis.access")
    assert log.isEnabledFor(logging.INFO)
    assert any(isinstance(h, logging.StreamHandler) for h in logging.getLogger("metis").handlers)
