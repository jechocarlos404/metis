"""REST errors: one shape, 404 for an unknown id, and oversized bodies refused.

`detail` is always there, as a sentence. The write boundary's 403 is the one
object (`{error, message, href}`), which agents and the seed scripts parse; a
name clash keeps the row it clashes with one key over, under `existing`.
"""

import json
import uuid

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.db import get_db
from app.main import MAX_BODY, MAX_READ_BODY, create_app, http_error
from app.schemas.capability import CapabilityCreate
from app.services import capabilities as capability_service


@pytest_asyncio.fixture
async def client(db):
    """The app on the test database, auth off (the boundary has its own suite)."""
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


async def test_motivations_of_an_unknown_capability_is_a_404(client, db):
    """Like /scope and /rollup: an empty list must mean "no goal motivates
    it", never "no such capability"."""
    unknown = uuid.uuid4()
    for tail in ("motivations", "scope", "rollup"):
        res = await client.get(f"/api/capabilities/{unknown}/{tail}")
        assert res.status_code == 404, tail
        assert res.json() == {"detail": "Capability not found"}
    async with db() as s:
        cap = await capability_service.create_capability(s, CapabilityCreate(name="Search"))
    res = await client.get(f"/api/capabilities/{cap.id}/motivations")
    assert res.status_code == 200 and res.json() == []


async def test_an_unknown_subject_reads_the_same_by_id_or_by_slug(client):
    """A subject in the path is "<Kind> not found", whether the route takes
    an id or a slug: the caller already holds what it asked for."""
    said = {
        f"/api/features/{uuid.uuid4()}": "Feature not found",
        f"/api/capabilities/{uuid.uuid4()}/scope": "Capability not found",
        "/api/capabilities/no-such/supply": "Capability not found",
        "/api/tech/no-such": "Technology not found",
        "/api/stacks/no-such/redundancy": "Product not found",
    }
    for path, detail in said.items():
        res = await client.get(path)
        assert (res.status_code, res.json()) == (404, {"detail": detail}), path


async def test_a_validation_error_reads_as_a_sentence(client):
    res = await client.get("/api/features/not-a-uuid")
    assert res.status_code == 422
    body = res.json()
    assert isinstance(body["detail"], str)
    assert body["detail"].startswith("path.feature_id: Input should be a valid UUID")
    # FastAPI's list is still there, one key over.
    assert body["errors"][0]["loc"] == ["path", "feature_id"]

    res = await client.post(
        "/api/capabilities/coverage",
        content=b"{not json", headers={"content-type": "application/json"},
    )
    assert res.status_code == 422 and "JSON decode error" in res.json()["detail"]


async def test_a_refusal_with_more_to_say_still_reads_as_a_sentence(client, db):
    """A clash names the row it clashes with one key over; a feature cycle
    keeps its ids the same way. Only the write boundary's 403 stays an object."""
    async with db() as s:
        await capability_service.create_capability(s, CapabilityCreate(name="Search"))
    res = await client.post("/api/capabilities", json={"name": "search"})
    assert (res.status_code, res.json()) == (
        409, {"detail": '"Search" already exists', "existing": {"slug": "search", "name": "Search"}}
    )

    said = await http_error(None, HTTPException(409, {"message": "A circle.", "cycle": ["a", "b"]}))
    assert json.loads(said.body) == {"detail": "A circle.", "cycle": ["a", "b"]}
    boundary = {"error": "human_action_required", "message": "A human action.", "href": "/home"}
    said = await http_error(None, HTTPException(403, boundary))
    assert json.loads(said.body) == {"detail": boundary}
    said = await http_error(None, HTTPException(404, "Feature not found"))
    assert json.loads(said.body) == {"detail": "Feature not found"}


def _idea(size: int) -> bytes:
    return json.dumps({"features": [{"name": "x", "capabilities": ["a" * size]}]}).encode()


async def test_an_oversized_read_body_is_refused_before_it_is_parsed(client):
    res = await client.post(
        "/api/capabilities/coverage",
        content=_idea(MAX_READ_BODY + 1),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 413
    assert res.json() == {"detail": f"Request body is over {MAX_READ_BODY} bytes."}
    # A real idea is a few KB and goes through.
    res = await client.post(
        "/api/capabilities/coverage",
        content=_idea(2_000),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 200


async def test_a_streamed_body_is_counted_too(client):
    """The Astro proxy streams bodies with no content-length, so the declared
    length alone would let every browser request through."""
    payload = _idea(MAX_READ_BODY + 1)

    async def chunks():
        for i in range(0, len(payload), 8_192):
            yield payload[i:i + 8_192]

    res = await client.post(
        "/api/capabilities/coverage",
        content=chunks(),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 413
    assert res.json() == {"detail": f"Request body is over {MAX_READ_BODY} bytes."}


@pytest.mark.parametrize("streamed", [False, True])
async def test_writes_get_the_larger_cap(client, streamed):
    """A write needs an editor on the desktop; its cap only stops a runaway."""
    payload = json.dumps({"name": "n" * (MAX_BODY + 1)}).encode()

    async def chunks():
        for i in range(0, len(payload), 65_536):
            yield payload[i:i + 65_536]

    res = await client.post(
        "/api/capabilities",
        content=chunks() if streamed else payload,
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 413
    assert res.json()["detail"] == f"Request body is over {MAX_BODY} bytes."
    # Over the read cap, under the write cap: an ordinary write.
    long = {"name": "Long description", "description": "d" * (MAX_READ_BODY + 10)}
    res = await client.post("/api/capabilities", json=long)
    assert res.status_code == 201
