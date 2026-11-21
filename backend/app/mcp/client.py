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


class SetupError(Exception):
    """This server cannot reach, or sign in to, what it depends on. The message
    says which one and the setting that points at it, so a misconfiguration
    reads as one rather than as a raw transport error."""


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
        keycloak = self._settings.keycloak_internal_url.rstrip("/")
        who = self._settings.keycloak_mcp_client
        try:
            response = await self._http.post(
                f"{keycloak}/realms/{self._settings.keycloak_realm}"
                "/protocol/openid-connect/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": who,
                    "client_secret": self._settings.keycloak_mcp_client_secret,
                },
            )
        except httpx.TransportError as exc:
            raise SetupError(
                f"Cannot reach Keycloak at {keycloak} ({_reason(exc)}), so this server "
                f"cannot sign in as {who}. Start Keycloak, or point "
                "KEYCLOAK_INTERNAL_URL at it."
            ) from exc
        if response.status_code >= 400:
            raise SetupError(
                f"Keycloak refused to sign this server in as {who} "
                f"({response.status_code}{_keycloak_reason(response)}). Check "
                "METIS_MCP_CLIENT_SECRET and KEYCLOAK_REALM."
            )
        payload = response.json()
        self._token = payload["access_token"]
        # Refresh a minute early rather than discovering expiry mid-answer.
        self._expires_at = time.monotonic() + max(30, payload.get("expires_in", 300) - 60)
        return self._token

    async def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        token = await self._bearer()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            response = await self._http.request(
                method, f"{self.base}{path}", headers=headers, **kwargs
            )
        except httpx.TransportError as exc:
            raise SetupError(
                f"Cannot reach the metis API at {self.base} ({_reason(exc)}). Start "
                "the backend, or point MCP_API_BASE_URL at it."
            ) from exc
        if response.status_code == 404 and not _metis_404(_body(response)):
            raise SetupError(
                f"{self.base} answered 404 to {path} the way no metis route does, so it "
                "isn't the metis API, or not its root. Point MCP_API_BASE_URL at the "
                "backend's root (for example http://localhost:8000, without /api)."
            )
        if response.status_code >= 400:
            raise ApiError(response.status_code, _body(response))
        return response

    async def get(self, path: str, params: dict | None = None) -> dict:
        params = {k: v for k, v in (params or {}).items() if v is not None}
        return (await self._send("GET", path, params=params)).json()

    async def post(self, path: str, json: dict | None = None) -> dict:
        return (await self._send("POST", path, json=json or {})).json()

    async def text(self, path: str) -> str:
        return (await self._send("GET", path)).text

    async def aclose(self) -> None:
        await self._http.aclose()


def _body(response: httpx.Response):
    try:
        return response.json()
    except ValueError:
        return response.text


def _metis_404(body) -> bool:
    """Every metis 404 names what was not found in `detail`. A path no route
    matches gets FastAPI's bare "Not Found", and another service answers in
    its own shape: both mean the base URL is wrong, not the subject."""
    return isinstance(body, dict) and isinstance(body.get("detail"), str) and body["detail"] != "Not Found"


def _reason(exc: httpx.TransportError) -> str:
    return str(exc) or type(exc).__name__


def _keycloak_reason(response: httpx.Response) -> str:
    """Keycloak's own words for a refused grant, when it sent any."""
    body = _body(response)
    if isinstance(body, dict):
        said = body.get("error_description") or body.get("error")
        if said:
            return f": {said}"
    return ""
