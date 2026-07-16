"""FastAPI auth dependencies + the pure RBAC decision.

Role model:
  - viewer  → read (GET/HEAD) any domain route
  - editor  → also write (POST/PATCH/PUT/DELETE) domain routes
  - admin   → also user management + LLM config

`authorize()` is kept pure so the RBAC matrix can be unit-tested without HTTP.
"""

from fastapi import Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool

from app.auth.jwt import Principal, TokenVerifier
from app.config import Settings, get_settings

# Identity used when auth_enabled=false (local dev / tests).
DEV_PRINCIPAL = Principal(
    sub="dev", username="dev", name="Dev (auth disabled)", roles=["admin"]
)

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _verifier(request: Request, settings: Settings) -> TokenVerifier:
    verifier = getattr(request.app.state, "verifier", None)
    if verifier is None:
        verifier = TokenVerifier(settings)
        request.app.state.verifier = verifier
    return verifier


async def current_user(
    request: Request, settings: Settings = Depends(get_settings)
) -> Principal:
    if not settings.auth_enabled:
        return DEV_PRINCIPAL
    auth = request.headers.get("Authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await run_in_threadpool(_verifier(request, settings).verify, token)


def authorize(method: str, principal: Principal) -> None:
    """RBAC decision. Reads for any authenticated user; writes need editor/admin."""
    if method.upper() in _SAFE_METHODS:
        return
    if not principal.has_any("editor", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires editor or admin role")


async def enforce_rbac(
    request: Request, principal: Principal = Depends(current_user)
) -> Principal:
    authorize(request.method, principal)
    return principal


async def require_admin(principal: Principal = Depends(current_user)) -> Principal:
    if not principal.has_role("admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires admin role")
    return principal
