"""Guessed capability links (owner's rule, 2026-11-20): stored apart from
confirmed links, never counted in scores, visible to editors and admins only,
and turned into a fact only by a person confirming one."""
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, require_editor
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import TechKind
from app.models.enums import Surface
from app.schemas.capability import CapabilityCreate
from app.schemas.feature import FeatureCreate
from app.schemas.technology import TechnologyCreate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services import technologies as tech_service


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


@pytest_asyncio.fixture
async def world(db):
    """One capability, one feature whose capabilities are unknown, one technology."""
    async with db() as session:
        sso = await capability_service.create_capability(session, CapabilityCreate(name="Single Sign-On"))
        feature = await feature_service.create_feature(
            session, FeatureCreate(name="Sign in with your company account", unknown_capabilities=True)
        )
        tech = await tech_service.create_technology(
            session, TechnologyCreate(slug="keycloak", name="Keycloak", kind=TechKind.service)
        )
        return {"cap": str(sso.id), "feature": str(feature.id), "tech": str(tech.id)}


async def _guess(client, world, **extra):
    body = {"capability_id": world["cap"], "feature_id": world["feature"], "confidence": "medium",
            "basis": "pricing page lists SSO", **extra}
    res = await client.post("/api/guesses", json=body)
    assert res.status_code == 201, res.text
    return res.json()


async def test_a_guess_is_listed_with_names(client, world):
    guess = await _guess(client, world)
    assert guess["capability_name"] == "Single Sign-On"
    assert guess["subject_name"] == "Sign in with your company account"
    listed = (await client.get("/api/guesses", params={"feature_id": world["feature"]})).json()
    assert [g["id"] for g in listed] == [guess["id"]]


async def test_a_guess_is_not_a_link(client, world):
    await _guess(client, world)
    feature = (await client.get(f"/api/features/{world['feature']}")).json()
    assert feature["capability_ids"] == []
    inventory = (await client.get("/api/capabilities/inventory")).json()
    sso = next(row for row in inventory if row["name"] == "Single Sign-On")
    assert sso["features"] == 0 and sso["products"] == []
    coverage = (await client.post("/api/capabilities/coverage", json={"features": [
        {"name": "idea", "capabilities": ["Single Sign-On"]}]})).json()
    match = coverage["features"][0]["capabilities"][0]["match"]
    # The capability exists by name, but no feature realizes it.
    assert match["products"] == []


async def test_posting_the_same_pair_updates_it(client, world):
    first = await _guess(client, world)
    second = await _guess(client, world, confidence="high", basis="docs page shows it")
    assert second["id"] == first["id"]
    assert second["confidence"] == "high"


async def test_confirm_makes_it_a_link_and_removes_the_guess(client, world):
    guess = await _guess(client, world)
    assert (await client.post(f"/api/guesses/{guess['id']}/confirm")).status_code == 204
    feature = (await client.get(f"/api/features/{world['feature']}")).json()
    assert feature["capability_ids"] == [world["cap"]]
    assert (await client.get("/api/guesses")).json() == []


async def test_a_guess_cannot_shadow_a_confirmed_link(client, world):
    guess = await _guess(client, world)
    await client.post(f"/api/guesses/{guess['id']}/confirm")
    res = await client.post("/api/guesses", json={
        "capability_id": world["cap"], "feature_id": world["feature"], "confidence": "low"})
    assert res.status_code == 409


async def test_linking_by_patch_retires_the_matching_guess_only(client, world):
    await _guess(client, world)
    other = (await client.post("/api/capabilities", json={"name": "Audit Log"})).json()["id"]
    kept = await _guess(client, {**world, "cap": other})
    res = await client.patch(f"/api/features/{world['feature']}", json={
        "capability_ids": [world["cap"]], "unknown_capabilities": False})
    assert res.status_code == 200, res.text
    assert res.json()["capability_ids"] == [world["cap"]]
    # A fact and a guess about the same link never coexist; other guesses stay.
    assert [g["id"] for g in (await client.get("/api/guesses")).json()] == [kept["id"]]


async def test_reject_deletes_it(client, world):
    guess = await _guess(client, world)
    assert (await client.delete(f"/api/guesses/{guess['id']}")).status_code == 204
    assert (await client.get("/api/guesses")).json() == []
    feature = (await client.get(f"/api/features/{world['feature']}")).json()
    assert feature["capability_ids"] == []


async def test_technology_guess_confirms_into_a_satisfaction(client, world):
    res = await client.post("/api/guesses", json={
        "capability_id": world["cap"], "tech_id": world["tech"], "confidence": "high", "fit": "native"})
    assert res.status_code == 201, res.text
    await client.post(f"/api/guesses/{res.json()['id']}/confirm")
    sats = (await client.get("/api/tech/satisfactions", params={"tech_id": world["tech"]})).json()
    assert [(s["capability_id"], s["fit"]) for s in sats] == [(world["cap"], "native")]


@pytest.mark.parametrize("body", [
    {"confidence": "medium"},  # no subject
    {"confidence": "medium", "feature_id": "F", "tech_id": "T"},  # two subjects
    {"confidence": "medium", "feature_id": "F", "fit": "native"},  # fit without a technology
    {"confidence": "certain", "feature_id": "F"},  # not a confidence
])
async def test_bad_guesses_are_refused(client, world, body):
    body = {k: world["feature"] if v == "F" else world["tech"] if v == "T" else v for k, v in body.items()}
    res = await client.post("/api/guesses", json={"capability_id": world["cap"], **body})
    assert res.status_code == 422


async def test_deleting_the_feature_removes_its_guesses(client, world):
    await _guess(client, world)
    assert (await client.delete(f"/api/features/{world['feature']}")).status_code == 204
    assert (await client.get("/api/guesses")).json() == []


@pytest.mark.parametrize("roles,surface", [
    (["viewer"], Surface.desktop),
    (["viewer"], Surface.mcp),  # agents read through the MCP service, a viewer
])
async def test_viewers_and_agents_cannot_see_guesses(roles, surface):
    with pytest.raises(HTTPException) as refused:
        await require_editor(Principal(sub="u", username="u", roles=roles, surface=surface))
    assert refused.value.status_code == 403


async def test_editors_can_see_guesses():
    editor = Principal(sub="u", username="u", roles=["editor"], surface=Surface.desktop)
    assert await require_editor(editor) is editor
