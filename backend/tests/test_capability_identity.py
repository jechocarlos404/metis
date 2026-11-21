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


async def test_an_accented_name_stored_before_the_fold_still_guards_its_name(client, db):
    """Slugs fold accents now, but a row stored before keeps its old slug
    ("Résumé Parsing" is r-sum-parsing): its name must still guard."""
    async with db() as session:
        session.add(Capability(name="Résumé Parsing", slug="r-sum-parsing"))
        await session.commit()
    for name in ("Résumé-Parsing", "Résumé  Parsing", "Resume Parsing", "resume parsing"):
        res = await _create(client, name)
        assert res.status_code == 409, (name, res.json())
        assert res.json()["existing"] == {"slug": "r-sum-parsing", "name": "Résumé Parsing"}


async def test_a_renamed_capability_guards_its_new_name_in_any_punctuation(client):
    made = (await _create(client, "Semantic Search")).json()
    await client.patch(f"/api/capabilities/{made['id']}", json={"name": "Vector Retrieval"})
    assert (await _create(client, "vector-retrieval")).status_code == 409


async def test_a_feature_name_differing_only_in_case_is_refused_in_one_product(client, db):
    """B51: "qa-b5 keep notes when OFFLINE" was created beside "QA-B5 Keep notes
    when offline" in one product. It is refused, naming the one that exists;
    the same name in another product, or a case change of the feature itself,
    still goes through."""
    trail = (await client.post("/api/products", json={"name": "Trail Notes"})).json()["id"]
    other = (await client.post("/api/products", json={"name": "Other Notes"})).json()["id"]

    async def feature(name, product, **extra):
        return await client.post(
            "/api/features", json={"name": name, "product_id": product, "unknown_capabilities": True, **extra}
        )

    first = await feature("Keep notes when offline", trail)
    assert first.status_code == 201
    res = await feature("keep notes when OFFLINE", trail)
    assert res.status_code == 409
    assert res.json() == {
        "detail": '"Keep notes when offline" is already in this product',
        "existing": {"id": first.json()["id"], "name": "Keep notes when offline"},
    }
    assert (await feature("Keep notes when offline", other)).status_code == 201
    loose = await feature("Sync later", None)
    assert loose.status_code == 201
    assert (await feature("sync LATER", None)).json()["detail"] == '"Sync later" is already in the features with no product'

    # A rename into a clash is refused; renaming itself in another case is not.
    sync = (await feature("Sync notes later", trail)).json()["id"]
    res = await client.patch(f"/api/features/{sync}", json={"name": "KEEP notes when offline"})
    assert res.status_code == 409
    assert (await client.patch(f"/api/features/{sync}", json={"name": "Sync Notes Later"})).status_code == 200
    # So is a move into a product that has it.
    moved = (await feature("Keep notes when offline", None)).json()["id"]
    assert (await client.patch(f"/api/features/{moved}", json={"product_id": trail})).status_code == 409

    async with db() as session:
        ctx = ToolContext(session=session)
        with pytest.raises(ToolError) as err:
            await tools.create_feature(ctx, name="keep notes when offline", product="Trail Notes", unknown_capabilities=True)
        assert str(err.value) == '"Keep notes when offline" is already in this product'
