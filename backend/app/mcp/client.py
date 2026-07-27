"""HTTP client for the MCP server.

The MCP server talks to the same HTTP API a human's browser does, rather than
to the services in-process. Two reasons, and both are load-bearing:

1. A chat transcript and an API log line up, because there *is* an API log
   line. That is the whole claim of "three renderings of one answer".
2. The write boundary becomes structural instead of conventional. The token
   this client carries is issued to `metis-mcp`, the backend derives
   `Surface.mcp` from the signed `azp`, and any write comes back 403
   `human_action_required`. Nothing here re-implements that rule; it inherits
   it, which is why it cannot drift.
"""

import time

import httpx

from app.config import get_settings


class ApiError(Exception):
    """A non-2xx the tool layer should render rather than swallow."""

    def __init__(self, status: int, body):
        self.status = status
        self.body = body
        super().__init__(f"{status}: {body}")


class MetisClient:
    """Read-only by construction: the token it holds cannot write."""

    def __init__(self, base_url: str | None = None):
        settings = get_settings()
        self.base = (base_url or settings.mcp_api_base_url).rstrip("/")
        self._settings = settings
        self._token: str | None = None
        self._expires_at = 0.0
        self._http = httpx.AsyncClient(timeout=30)

    async def _bearer(self) -> str | None:
        """Client-credentials, cached until shortly before it expires. Returns
        None when auth is off, which is the local dev case."""
        if not self._settings.auth_enabled:
            return None
        if self._token and time.monotonic() < self._expires_at:
            return self._token
        response = await self._http.post(
            f"{self._settings.keycloak_internal_url.rstrip('/')}"
            f"/realms/{self._settings.keycloak_realm}/protocol/openid-connect/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self._settings.keycloak_mcp_client,
                "client_secret": self._settings.keycloak_mcp_client_secret,
            },
        )
        response.raise_for_status()
        payload = response.json()
        self._token = payload["access_token"]
        # Refresh a minute early rather than discovering expiry mid-answer.
        self._expires_at = time.monotonic() + max(30, payload.get("expires_in", 300) - 60)
        return self._token

    async def get(self, path: str, params: dict | None = None) -> dict:
        token = await self._bearer()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = await self._http.get(
            f"{self.base}{path}",
            params={k: v for k, v in (params or {}).items() if v is not None},
            headers=headers,
        )
        if response.status_code >= 400:
            raise ApiError(response.status_code, _body(response))
        return response.json()

    async def post(self, path: str, json: dict | None = None) -> dict:
        token = await self._bearer()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = await self._http.post(
            f"{self.base}{path}", json=json or {}, headers=headers
        )
        if response.status_code >= 400:
            raise ApiError(response.status_code, _body(response))
        return response.json()

    async def text(self, path: str) -> str:
        token = await self._bearer()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = await self._http.get(f"{self.base}{path}", headers=headers)
        if response.status_code >= 400:
            raise ApiError(response.status_code, _body(response))
        return response.text

    async def aclose(self) -> None:
        await self._http.aclose()


def _body(response: httpx.Response):
    try:
        return response.json()
    except ValueError:
        return response.text
