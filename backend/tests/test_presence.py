"""GET /api/tech/presence: the nav's one cheap call to decide whether
Technology and Stacks are shown."""
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, authorize
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import TechKind
from app.models.enums import Surface
from app.schemas.stack import StackCreate
from app.schemas.technology import TechnologyCreate
from app.services import stacks as stack_service
from app.services import technologies as tech_service


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


async def test_empty_instance_has_neither(client):
    # A 200 here also shows /presence is not swallowed by /api/tech/{slug}.
    res = await client.get("/api/tech/presence")
    assert res.status_code == 200
    assert res.json() == {"technologies": False, "stacks": False}


async def test_one_technology(client, db):
    async with db() as session:
        await tech_service.create_technology(
            session, TechnologyCreate(slug="postgres", name="Postgres", kind=TechKind.service)
        )
    res = await client.get("/api/tech/presence")
    assert res.json() == {"technologies": True, "stacks": False}


async def test_one_stack(client, db):
    async with db() as session:
        await stack_service.create_stack(session, StackCreate(name="web stack"))
    res = await client.get("/api/tech/presence")
    assert res.json() == {"technologies": False, "stacks": True}


def test_viewer_can_read_presence():
    viewer = Principal(sub="u", username="u", roles=["viewer"], surface=Surface.desktop)
    authorize("GET", viewer, "/api/tech/presence")  # does not raise
