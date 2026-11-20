"""Every write under /api passes the surface gate.

require_admin checks the role only, so a router mounted with it alone is a
write path an api/mcp token can reach. enforce_rbac is what keeps writes on the
desktop; the reads that are POSTs (_READS_BY_POST) carry it too and are let
through inside it, so nothing here is exempt.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, enforce_rbac
from app.auth.deps import current_user
from app.db import get_db
from app.main import create_app
from app.models.enums import Surface

try:  # Newer FastAPI keeps included routers lazy; this flattens them.
    from fastapi.routing import iter_route_contexts
except ImportError:  # Older FastAPI: app.routes is already flat.
    def iter_route_contexts(routes):
        return routes

WRITES = {"POST", "PUT", "PATCH", "DELETE"}


def _calls(dependant):
    for dep in dependant.dependencies:
        yield dep.call
        yield from _calls(dep)


def _api_writes():
    """(method, path, dependant) for every mutating route under /api."""
    for route in iter_route_contexts(create_app().routes):
        if not (route.path or "").startswith("/api") or not hasattr(route, "dependant"):
            continue
        for method in (route.methods or set()) & WRITES:
            yield method, route.path, route.dependant


def test_every_api_write_carries_enforce_rbac():
    ungated = [
        (method, path)
        for method, path, dependant in _api_writes()
        if enforce_rbac not in _calls(dependant)
    ]
    assert ungated == []


def test_sweep_sees_the_admin_writes():
    """Guard against a vacuous pass: the routes this sweep exists for are in it."""
    seen = {(method, path) for method, path, _ in _api_writes()}
    assert ("POST", "/api/users") in seen
    assert ("PUT", "/api/admin/llm/configs/{agent_name}") in seen
    assert ("POST", "/api/capabilities/coverage") in seen


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/api/users"),
        ("PATCH", "/api/users/u1"),
        ("DELETE", "/api/users/u1"),
        ("POST", "/api/users/u1/reset-password"),
        ("PUT", "/api/admin/llm/configs/orchestrator"),
    ],
)
async def test_admin_writes_refused_off_desktop(method, path):
    """An admin's api/mcp token is still not a person at the desktop."""
    app = create_app()
    app.dependency_overrides[current_user] = lambda: Principal(
        sub="agent", username="agent", roles=["admin"], surface=Surface.mcp
    )
    app.dependency_overrides[get_db] = lambda: None  # refused before any query
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        res = await http.request(method, path, json={})
    assert res.status_code == 403
    assert res.json()["detail"]["error"] == "human_action_required"
