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


@pytest.mark.parametrize(
    "method, path, href",
    [
        ("POST", "/api/users", "/users"),
        ("PATCH", "/api/users/u1", "/users"),
        ("DELETE", "/api/users/u1", "/users"),
        ("POST", "/api/users/u1/reset-password", "/users"),
        ("PUT", "/api/admin/llm/configs/orchestrator", "/admin"),
        ("POST", "/api/admin/data/cascade-preview", "/data"),
        ("POST", "/api/admin/data/cascade-delete", "/data"),
    ],
)
async def test_the_mcp_token_hears_the_surface_before_the_role(method, path, href):
    """The MCP service is a viewer. On an admin route its write is refused as
    a human action, the same as every other write, not as a missing role: no
    role would help off the desktop."""
    app = create_app()
    app.dependency_overrides[current_user] = lambda: Principal(
        sub="metis-mcp", username="metis-mcp", roles=["viewer"], surface=Surface.mcp
    )
    app.dependency_overrides[get_db] = lambda: None
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        res = await http.request(method, path, json={})
    assert res.status_code == 403
    assert res.json()["detail"]["error"] == "human_action_required"
    assert res.json()["detail"]["href"] == href


async def test_on_the_desktop_an_admin_route_names_the_admin_role():
    """A viewer or editor at the desktop is a person: the role is the live
    question, and only admin would help."""
    app = create_app()
    app.dependency_overrides[get_db] = lambda: None
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        for roles in (["viewer"], ["editor"]):
            app.dependency_overrides[current_user] = lambda roles=roles: Principal(
                sub="p", username="p", roles=roles, surface=Surface.desktop
            )
            res = await http.post("/api/users", json={})
            assert (res.status_code, res.json()["detail"]) == (403, "Requires admin role")
        # A read by the MCP token is no write: the role answers it.
        app.dependency_overrides[current_user] = lambda: Principal(
            sub="metis-mcp", username="metis-mcp", roles=["viewer"], surface=Surface.mcp
        )
        res = await http.get("/api/users")
        assert (res.status_code, res.json()["detail"]) == (403, "Requires admin role")
