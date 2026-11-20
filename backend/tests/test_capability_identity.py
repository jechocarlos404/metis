"""One capability per name.

"user authentication" next to "User Authentication" used to become
`user-authentication-2`, splitting one capability's reuse across two rows. A
clash is now a 409 naming the one that exists; the seed loader reads that body
to reuse it, so its shape is pinned here over HTTP.
"""

import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.agents import tools
from app.agents.tools import ToolContext, ToolError
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import Capability

# `detail` is a sentence, as on every refusal; the row it clashes with is
# one key over.
CLASH = {
    "detail": '"User Authentication" already exists',
    "existing": {"slug": "user-authentication", "name": "User Authentication"},
}


@pytest_asyncio.fixture
async def client(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


async def _create(client, name, **extra):
    return await client.post("/api/capabilities", json={"name": name, **extra})


async def test_create_with_another_case_is_refused(client, db):
    assert (await _create(client, "User Authentication")).status_code == 201

    res = await _create(client, "user authentication")
    assert res.status_code == 409
    assert res.json() == CLASH
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(Capability)) == 1


async def test_explicit_slug_clash_names_the_existing_one(client):
    await _create(client, "User Authentication")
    res = await _create(client, "Sign-in", slug="user-authentication")
    assert res.status_code == 409
    assert res.json() == CLASH


async def test_renamed_capability_still_guards_its_new_name(client):
    """A rename keeps the old slug, so the clash is also found by name."""
    created = (await _create(client, "Login")).json()
    await client.patch(f"/api/capabilities/{created['id']}", json={"name": "User Authentication"})

    res = await _create(client, "user authentication")
    assert res.status_code == 409
    assert res.json() == {
        "detail": '"User Authentication" already exists',
        "existing": {"slug": "login", "name": "User Authentication"},
    }


async def test_case_only_rename_of_itself_is_fine(client):
    created = (await _create(client, "User Authentication")).json()
    res = await client.patch(
        f"/api/capabilities/{created['id']}", json={"name": "User authentication"}
    )
    assert res.status_code == 200
    assert res.json()["name"] == "User authentication"
    assert res.json()["slug"] == "user-authentication"


async def test_rename_onto_another_capability_is_refused(client):
    await _create(client, "User Authentication")
    other = (await _create(client, "Payments")).json()
    res = await client.patch(
        f"/api/capabilities/{other['id']}", json={"name": "user authentication"}
    )
    assert res.status_code == 409
    assert res.json() == CLASH


async def test_editing_an_older_duplicate_is_not_blocked(client, db):
    """Instances already hold `-2` rows from before. Saving one with its name
    unchanged must still work."""
    async with db() as session:
        session.add(Capability(name="Semantic search", slug="semantic-search"))
        session.add(Capability(name="Semantic Search", slug="semantic-search-2"))
        await session.commit()
        dup = await session.scalar(select(Capability).where(Capability.slug == "semantic-search-2"))
    res = await client.patch(
        f"/api/capabilities/{dup.id}", json={"name": "Semantic Search", "description": "Vectors"}
    )
    assert res.status_code == 200


async def test_products_still_get_a_suffix(client):
    first = await client.post("/api/products", json={"name": "metis"})
    second = await client.post("/api/products", json={"name": "Metis"})
    assert first.status_code == second.status_code == 201
    assert first.json()["slug"] == "metis"
    assert second.json()["slug"] == "metis-2"


async def test_agent_create_reuses_the_existing_capability(db):
    """A proposal that would make a duplicate applies by pointing at the one
    that exists, so later proposals naming it still go through."""
    async with db() as session:
        ctx = ToolContext(session=session)
        first = json.loads((await tools.create_capability(ctx, name="User Authentication")).result)
        again = json.loads((await tools.create_capability(ctx, name="user authentication")).result)
        assert again["id"] == first["id"]
        assert "already exists" in again["note"]
        assert await session.scalar(select(func.count()).select_from(Capability)) == 1


async def test_agent_rename_clash_is_a_clear_tool_error(db):
    async with db() as session:
        ctx = ToolContext(session=session)
        await tools.create_capability(ctx, name="User Authentication")
        await tools.create_capability(ctx, name="Payments")
        with pytest.raises(ToolError) as err:
            await tools.update_capability(ctx, capability="Payments", name="user authentication")
        assert '"User Authentication" already exists' in str(err.value)
