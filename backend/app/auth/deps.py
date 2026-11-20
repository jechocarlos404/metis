"""FastAPI auth dependencies + the pure authorization decision.

Two orthogonal gates. **Role** says what someone may do:

  - viewer  → read (GET/HEAD) any domain route
  - editor  → also write (POST/PATCH/PUT/DELETE) domain routes
  - admin   → also user management + LLM config

**Surface** says which door they came through, and only the desktop writes. An
agent that can bind a slot can silence a gap, and the gaps are the product —
the estate is only explainable a year later because every binding carries a
person and a reason, which an automated writer strips while looking like
progress.

`authorize()` is kept pure so both matrices can be unit-tested without HTTP.
"""

import re

from fastapi import Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool

from app.auth.jwt import Principal, TokenVerifier
from app.config import Settings, get_settings
from app.models.enums import Surface

# Identity used when auth_enabled=false (local dev / tests). Desktop, because
# the escape hatch exists to make local work behave like the real app.
DEV_PRINCIPAL = Principal(
    sub="dev",
    username="dev",
    name="Dev (auth disabled)",
    roles=["admin"],
    surface=Surface.desktop,
)

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

#: Reads that have to be POSTs because their input is a body. The write
#: boundary is about writes, not about verbs. Matched in full rather than by
#: suffix: the path is caller-controlled, and an exemption that widens by
#: accident is the kind that is discovered later rather than reviewed now.
_READS_BY_POST = (
    re.compile(r"/api/stacks/[^/]+/recommend"),
    re.compile(r"/api/capabilities/coverage"),
    re.compile(r"/api/graph/mvp-cut"),
)


def _is_read(method: str, path: str) -> bool:
    return method.upper() in _SAFE_METHODS or any(
        pattern.fullmatch(path) for pattern in _READS_BY_POST
    )


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


#: Each write path → the desktop screen where a person makes that change. First
#: match wins, so a specific path sits above its collection. An id the screen
#: can open travels along — only when it is shaped like one, since the path is
#: the caller's. A capability's page is addressed by slug, and this decision
#: is pure (no lookup), so a capability id opens the list.
_ID = r"(?P<id>[A-Za-z0-9-]+)"
_SCREENS = tuple(
    (re.compile(pattern), screen)
    for pattern, screen in (
        (rf"/api/stacks/slots/{_ID}/bind", "/stacks?slot={id}"),
        (r"/api/stacks(/.*)?", "/stacks"),
        (r"/api/(constraints|concerns)(/.*)?", "/stacks"),
        # The seed importer stamps this; seed files are loaded in Settings.
        (r"/api/products/[^/]+/seeded", "/settings#seed-files"),
        (rf"/api/products/{_ID}(/.*)?", "/products?product={id}"),
        (r"/api/(products|decompositions|tickets)(/.*)?", "/products"),
        (r"/api/features/edges(/.*)?", "/features"),
        (rf"/api/features/{_ID}", "/features?feature={id}"),
        (r"/api/(features|graph)(/.*)?", "/features"),
        (rf"/api/goals/{_ID}", "/goals?goal={id}"),
        (r"/api/goals", "/goals"),
        (r"/api/capabilities(/.*)?", "/capabilities"),
        (rf"/api/journeys/{_ID}", "/journeys?id={id}"),
        (r"/api/journeys", "/journeys"),
        # Guesses arrive in seed files and are confirmed where they show.
        (r"/api/guesses", "/settings#seed-files"),
        (r"/api/guesses/.*", "/features"),
        (r"/api/tech/(vendors|edges|satisfactions|encounters|versions)(/.*)?", "/tech"),
        (r"/api/tech/(?P<id>[a-z0-9-]+)(/.*)?", "/tech/{id}"),
        (r"/api/tech", "/tech"),
        (rf"/api/chat/threads/{_ID}(/.*)?", "/chat/{id}"),
        (r"/api/chat(/.*)?", "/chat"),
        (r"/api/users(/.*)?", "/users"),
        (r"/api/admin/llm(/.*)?", "/admin"),
        (r"/api/admin/data(/.*)?", "/data"),
    )
)


def _screen(path: str) -> str:
    for pattern, screen in _SCREENS:
        if match := pattern.fullmatch(path):
            return screen.format(**match.groupdict())
    return "/home"


def human_action(path: str) -> tuple[str, str]:
    """What was refused, and the screen that can do it. A refusal naming no
    next step is where an agent gives up silently."""
    if path.endswith("/bind"):
        return "Binding a slot is a human action.", _screen(path)
    return (
        "This is a human action — every write names a person and takes a rationale.",
        _screen(path),
    )


def authorize(method: str, principal: Principal, path: str = "") -> None:
    """Reads for any authenticated user; writes need the desktop *and* an
    editor/admin role.

    Surface is checked first because it is the more fundamental refusal: off
    the desktop no role would help, so answering "requires editor" would send
    the caller to fix the wrong thing. On the desktop the role is the live
    question, and a viewer hears about their role rather than being told a
    human is required when they are one."""
    if _is_read(method, path):
        return
    if principal.surface is not Surface.desktop:
        # Not 401 — the caller is who they say. Not 405 — the route exists.
        message, href = human_action(path)
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {"error": "human_action_required", "message": message, "href": href},
        )
    if not principal.has_any("editor", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires editor or admin role")


async def enforce_rbac(
    request: Request, principal: Principal = Depends(current_user)
) -> Principal:
    authorize(request.method, principal, request.url.path)
    return principal


async def require_editor(principal: Principal = Depends(current_user)) -> Principal:
    """Guesses are for the people who can confirm them: editors and admins.
    Viewers and agents (the MCP service is a viewer) never see them, so a
    guess cannot leak into an answer as if it were a fact."""
    if not principal.has_any("editor", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires editor or admin role")
    return principal


async def require_admin(principal: Principal = Depends(current_user)) -> Principal:
    if not principal.has_role("admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires admin role")
    return principal
