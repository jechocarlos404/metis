"""User management against a fake Keycloak Admin API.

The fake grants what metis-realm.json grants the metis-backend service
account (manage-users, view-users, query-users) and nothing more, so
GET /roles/{name}, which needs view-realm, answers 403 as the real one does.
"""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.routers.users import _call
from app.schemas.user import UserCreate, UserUpdate
from app.services.keycloak_admin import KeycloakAdmin, KeycloakAdminError

ADMIN = "/admin/realms/metis"


class FakeKeycloak:
    def __init__(self, realm_roles=("admin", "editor", "viewer")):
        names = [*realm_roles, "offline_access", "default-roles-metis"]
        self.roles = {n: {"id": f"role-{n}", "name": n} for n in names}
        self.users: dict[str, dict] = {}
        self.held: dict[str, set[str]] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail: dict[tuple[str, str], int] = {}  # (method, path suffix) → status

    def add_user(self, username, roles=()):
        uid = str(uuid.uuid4())
        self.users[uid] = {"id": uid, "username": username, "enabled": True}
        self.held[uid] = {"default-roles-metis", *roles}
        return uid

    def handler(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        if path.endswith("/protocol/openid-connect/token"):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
        assert path.startswith(ADMIN), path
        path = path[len(ADMIN):]
        self.calls.append((method, path))
        for (m, suffix), status in self.fail.items():
            if m == method and path.endswith(suffix):
                return httpx.Response(status, json={"error": f"HTTP {status}"})
        parts = path.strip("/").split("/")
        body = json.loads(request.content) if request.content else None

        if parts[0] == "roles":
            return httpx.Response(403, json={"error": "HTTP 403 Forbidden"})  # needs view-realm
        if parts == ["users"] and method == "POST":
            if any(u["username"] == body["username"] for u in self.users.values()):
                return httpx.Response(409, json={"errorMessage": "User exists with same username"})
            uid = self.add_user(body["username"])
            self.users[uid].update(body)
            return httpx.Response(201, headers={"Location": f"http://kc{ADMIN}/users/{uid}"})
        uid = parts[1]
        if uid not in self.users:
            return httpx.Response(404, json={"error": "User not found"})
        if parts[2:] == []:
            if method == "DELETE":
                del self.users[uid]
                return httpx.Response(204)
            if method == "PUT":
                self.users[uid].update(body)
                return httpx.Response(204)
            return httpx.Response(200, json=self.users[uid])
        if parts[2:] == ["role-mappings", "realm"]:
            if method == "GET":
                return httpx.Response(200, json=[self.roles[n] for n in sorted(self.held[uid])])
            names = {r["name"] for r in body}
            if method == "POST":
                self.held[uid] |= names
            else:
                self.held[uid] -= names
            return httpx.Response(204)
        if parts[2:] == ["role-mappings", "realm", "available"]:
            free = [r for n, r in self.roles.items() if n not in self.held[uid]]
            return httpx.Response(200, json=free)
        return httpx.Response(404)

    def managed(self, uid):
        return self.held[uid] & {"admin", "editor", "viewer"}


@pytest.fixture
def kc(monkeypatch):
    fake = FakeKeycloak()
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(fake.handler), **kw),
    )
    return fake


def _admin():
    return KeycloakAdmin(SimpleNamespace(
        keycloak_internal_url="http://kc", keycloak_realm="metis",
        keycloak_admin_client_id="metis-backend", keycloak_admin_client_secret="s",
    ))


NEW = UserCreate(username="qa-f8-new", email="qa-f8-new@metis.local", role="viewer", password="pw")


async def test_create_gives_the_role_without_view_realm(kc):
    user = await _admin().create_user(NEW)
    assert user["role"] == "viewer"
    assert kc.managed(user["id"]) == {"viewer"}
    assert not any(path.startswith("/roles") for _, path in kc.calls)


async def test_create_removes_the_account_when_the_role_fails(kc):
    kc.fail[("POST", "/role-mappings/realm")] = 403
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await _admin().create_user(NEW)
    assert exc.value.response.status_code == 403
    assert kc.users == {}
    # So a retry creates the user instead of hitting "user exists".
    kc.fail.clear()
    assert (await _admin().create_user(NEW))["role"] == "viewer"


async def test_create_says_when_the_half_made_account_is_left_behind(kc):
    kc.fail[("POST", "/role-mappings/realm")] = 403
    kc.fail[("DELETE", "")] = 500  # every DELETE, including the cleanup
    with pytest.raises(KeycloakAdminError, match="qa-f8-new was created in Keycloak but got no role"):
        await _admin().create_user(NEW)


async def test_create_rolls_back_when_the_realm_lacks_the_role(monkeypatch):
    fake = FakeKeycloak(realm_roles=("admin", "editor"))
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(fake.handler), **kw),
    )
    with pytest.raises(KeycloakAdminError, match="no viewer role"):
        await _admin().create_user(NEW)
    assert fake.users == {}


async def test_role_change_gives_the_new_role_before_taking_the_old(kc):
    uid = kc.add_user("someone", roles=("editor",))
    user = await _admin().update_user(uid, UserUpdate(role="viewer"))
    assert user["role"] == "viewer"
    assert kc.managed(uid) == {"viewer"}
    writes = [(m, p) for m, p in kc.calls if m in ("POST", "DELETE")]
    assert writes[0][0] == "POST" and writes[-1][0] == "DELETE"


async def test_failed_role_change_keeps_the_old_role(kc):
    uid = kc.add_user("someone", roles=("editor",))
    kc.fail[("POST", "/role-mappings/realm")] = 403
    with pytest.raises(httpx.HTTPStatusError):
        await _admin().update_user(uid, UserUpdate(role="viewer"))
    assert kc.managed(uid) == {"editor"}


async def test_role_already_held_only_drops_the_others(kc):
    uid = kc.add_user("someone", roles=("viewer", "editor"))
    await _admin().update_user(uid, UserUpdate(role="viewer"))
    assert kc.managed(uid) == {"viewer"}
    assert ("POST", f"/users/{uid}/role-mappings/realm") not in kc.calls


async def test_role_given_to_a_user_with_none(kc):
    uid = kc.add_user("orphan")
    assert (await _admin().get_user(uid))["role"] is None
    assert (await _admin().update_user(uid, UserUpdate(role="editor")))["role"] == "editor"


async def test_edit_without_a_role_leaves_roles_alone(kc):
    uid = kc.add_user("orphan")
    await _admin().update_user(uid, UserUpdate(first_name="Orphan"))
    assert not any("role-mappings" in p and m != "GET" for m, p in kc.calls)
    assert kc.managed(uid) == set()


async def _raise(exc):
    raise exc


def _status_error(code):
    request = httpx.Request("POST", "http://kc/x")
    return httpx.HTTPStatusError("x", request=request, response=httpx.Response(code, request=request, json={"error": f"HTTP {code} Forbidden"}))


async def test_a_refusal_reads_as_a_sentence():
    with pytest.raises(HTTPException) as exc:
        await _call(_raise(_status_error(403)), "create the user")
    assert exc.value.status_code == 502
    assert exc.value.detail == (
        "Keycloak didn't let metis create the user: its metis-backend service account "
        "is missing a permission."
    )


async def test_conflict_passes_through():
    request = httpx.Request("POST", "http://kc/x")
    err = httpx.HTTPStatusError("x", request=request, response=httpx.Response(
        409, request=request, json={"errorMessage": "User exists with same username"}))
    with pytest.raises(HTTPException) as exc:
        await _call(_raise(err), "create the user")
    assert (exc.value.status_code, exc.value.detail) == (409, "User exists with same username")


async def test_unreachable_keycloak_reads_as_a_sentence():
    with pytest.raises(HTTPException) as exc:
        await _call(_raise(httpx.ConnectError("refused")), "list users")
    assert exc.value.detail == "metis couldn't reach Keycloak to list users."
