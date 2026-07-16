"""Keycloak Admin REST API client.

Authenticates with the `metis-backend` service account (client_credentials) and
exposes just the user-management operations the admin UI needs. One managed realm
role per user (admin/editor/viewer) is the app's convention.
"""

import asyncio
import time

import httpx

from app.config import Settings
from app.schemas.user import PasswordReset, UserCreate, UserUpdate

MANAGED_ROLES = ("admin", "editor", "viewer")


def _shape(raw: dict, role: str | None) -> dict:
    return {
        "id": raw["id"],
        "username": raw.get("username", ""),
        "email": raw.get("email"),
        "first_name": raw.get("firstName"),
        "last_name": raw.get("lastName"),
        "enabled": raw.get("enabled", True),
        "role": role,
    }


class KeycloakAdmin:
    def __init__(self, settings: Settings):
        self._base = settings.keycloak_internal_url.rstrip("/")
        self._realm = settings.keycloak_realm
        self._client_id = settings.keycloak_admin_client_id
        self._client_secret = settings.keycloak_admin_client_secret
        self._token: str | None = None
        self._token_exp: float = 0.0

    @property
    def _admin(self) -> str:
        return f"{self._base}/admin/realms/{self._realm}"

    async def _token_for(self, c: httpx.AsyncClient) -> str:
        now = time.monotonic()
        if self._token and now < self._token_exp:
            return self._token
        resp = await c.post(
            f"{self._base}/realms/{self._realm}/protocol/openid-connect/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
        )
        resp.raise_for_status()
        payload = resp.json()
        self._token = payload["access_token"]
        self._token_exp = now + payload.get("expires_in", 60) - 15
        return self._token

    async def _api(
        self, c: httpx.AsyncClient, token: str, method: str, path: str, **kw
    ) -> httpx.Response:
        resp = await c.request(
            method,
            f"{self._admin}{path}",
            headers={"Authorization": f"Bearer {token}"},
            **kw,
        )
        resp.raise_for_status()
        return resp

    async def _role_rep(self, c, token, name: str) -> dict:
        return (await self._api(c, token, "GET", f"/roles/{name}")).json()

    async def _user_role(self, c, token, uid: str) -> str | None:
        rows = (await self._api(c, token, "GET", f"/users/{uid}/role-mappings/realm")).json()
        names = {r["name"] for r in rows}
        return next((r for r in MANAGED_ROLES if r in names), None)

    async def _assign_role(self, c, token, uid: str, role: str) -> None:
        await self._api(
            c, token, "POST", f"/users/{uid}/role-mappings/realm",
            json=[await self._role_rep(c, token, role)],
        )

    async def _set_role(self, c, token, uid: str, role: str) -> None:
        current = (await self._api(c, token, "GET", f"/users/{uid}/role-mappings/realm")).json()
        stale = [r for r in current if r["name"] in MANAGED_ROLES]
        if stale:
            await self._api(c, token, "DELETE", f"/users/{uid}/role-mappings/realm", json=stale)
        await self._assign_role(c, token, uid, role)

    async def _shaped(self, c, token, uid: str) -> dict:
        raw = (await self._api(c, token, "GET", f"/users/{uid}")).json()
        return _shape(raw, await self._user_role(c, token, uid))

    async def list_users(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            rows = (await self._api(
                c, token, "GET", "/users",
                params={"max": 500, "briefRepresentation": "false"},
            )).json()
            rows = [u for u in rows if not u.get("username", "").startswith("service-account-")]
            roles = await asyncio.gather(*(self._user_role(c, token, u["id"]) for u in rows))
            return [_shape(u, r) for u, r in zip(rows, roles)]

    async def get_user(self, uid: str) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            return await self._shaped(c, token, uid)

    async def create_user(self, data: UserCreate) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            rep = {
                "username": data.username,
                "email": data.email,
                "firstName": data.first_name,
                "lastName": data.last_name,
                "enabled": True,
                "emailVerified": True,
                "credentials": [
                    {"type": "password", "value": data.password, "temporary": data.temporary}
                ],
            }
            resp = await self._api(c, token, "POST", "/users", json=rep)
            uid = resp.headers["Location"].rstrip("/").rsplit("/", 1)[-1]
            await self._assign_role(c, token, uid, data.role)
            return await self._shaped(c, token, uid)

    async def update_user(self, uid: str, data: UserUpdate) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            patch = {}
            if data.email is not None:
                patch["email"] = data.email
            if data.first_name is not None:
                patch["firstName"] = data.first_name
            if data.last_name is not None:
                patch["lastName"] = data.last_name
            if data.enabled is not None:
                patch["enabled"] = data.enabled
            if patch:
                current = (await self._api(c, token, "GET", f"/users/{uid}")).json()
                await self._api(c, token, "PUT", f"/users/{uid}", json={**current, **patch})
            if data.role is not None:
                await self._set_role(c, token, uid, data.role)
            return await self._shaped(c, token, uid)

    async def delete_user(self, uid: str) -> None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            await self._api(c, token, "DELETE", f"/users/{uid}")

    async def reset_password(self, uid: str, data: PasswordReset) -> None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            token = await self._token_for(c)
            await self._api(
                c, token, "PUT", f"/users/{uid}/reset-password",
                json={"type": "password", "value": data.password, "temporary": data.temporary},
            )
