import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.auth import (
    Principal,
    TokenVerifier,
    authorize,
    current_user,
    enforce_rbac,
    require_admin,
    require_editor,
)
from app.auth.deps import _is_read
from app.config import get_settings
from app.db import init_db, make_engine
from app.llm.registry import ProviderRegistry
from app.models.enums import Surface
from app.routers import (
    admin_data,
    admin_llm,
    capabilities,
    chat,
    features,
    goals,
    governance,
    graph,
    guesses,
    health,
    journeys,
    products,
    questions,
    stacks,
    strategies,
    tech,
    users,
    work,
)
from app.services.graph_service import FeatureGraph
from app.agents.runner import mark_interrupted
from app.services.seed import ensure_agent_configs


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine, sessionmaker = make_engine(settings.database_url)
    app.state.engine = engine
    app.state.sessionmaker = sessionmaker
    await init_db(engine)
    await ensure_agent_configs(sessionmaker)
    app.state.graph = FeatureGraph(sessionmaker)
    await app.state.graph.load()
    app.state.llm = ProviderRegistry(settings)
    # Background chat turns. Nothing survives a restart, so none may look running.
    app.state.runs = set()
    await mark_interrupted(sessionmaker)
    app.state.verifier = TokenVerifier(settings) if settings.auth_enabled else None
    yield
    for task in list(app.state.runs):
        task.cancel()
    await asyncio.gather(*app.state.runs, return_exceptions=True)
    await engine.dispose()


#: Request bodies over these are refused with 413 before they are parsed. The
#: reads-by-POST (coverage, recommend, mvp-cut) are open to viewers and the MCP
#: token, and their near-name search costs time per byte, so they get a small
#: cap; a real idea or a seed file's new names fit in a few KB. Writes need an
#: editor on the desktop and send one row each (the largest stored value in a
#: full instance is about 3 KB), so their cap only stops a runaway.
MAX_READ_BODY = 64_000
MAX_BODY = 1_000_000


class BodyLimit:
    """Counts what arrives, not only the declared length: the Astro proxy
    streams bodies without a content-length."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = MAX_READ_BODY if _is_read("POST", scope["path"]) else MAX_BODY
        too_large = f"Request body is over {limit} bytes."
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            response = JSONResponse({"detail": too_large}, status_code=413)
            return await response(scope, receive, send)
        seen = 0

        async def counted():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise HTTPException(413, too_large)
            return message

        await self.app(scope, counted, send)


async def validation_error(request, exc: RequestValidationError) -> JSONResponse:
    """`detail` is a sentence here like everywhere else, not FastAPI's list,
    which stays one key over under `errors` for a client that wants it."""
    errors = jsonable_encoder(exc.errors())
    said = "; ".join(
        f"{'.'.join(str(part) for part in e.get('loc', []))}: {e.get('msg', '')}"
        for e in errors
    )
    return JSONResponse({"detail": said, "errors": errors}, status_code=422)


async def http_error(request, exc: StarletteHTTPException):
    """`detail` is a sentence here too. A refusal raised with more to say
    (a dict with a `message`) keeps the rest one key over: a name clash names
    the row it clashes with under `existing`. In-process callers still get the
    dict. The write boundary's 403 keeps its `{error, message, href}` detail:
    the MCP server and the seed scripts parse it. A 422 the API raises itself
    carries the `errors` list a validation error has, so a client reads every
    422 one way; its rule is about the request, not one field, so `loc` is
    empty."""
    detail = exc.detail
    if exc.status_code == 422 and isinstance(detail, str):
        return JSONResponse(
            {"detail": detail, "errors": [{"type": "value_error", "loc": [], "msg": detail}]},
            status_code=422,
            headers=exc.headers,
        )
    if not isinstance(detail, dict) or "message" not in detail or "error" in detail:
        return await http_exception_handler(request, exc)
    rest = {key: value for key, value in detail.items() if key != "message"}
    if {"slug", "name"} <= rest.keys():
        rest = {"existing": {"slug": rest.pop("slug"), "name": rest.pop("name")}, **rest}
    return JSONResponse(
        {"detail": detail["message"], **rest}, status_code=exc.status_code, headers=exc.headers
    )


async def surface_first(request: Request, principal: Principal = Depends(current_user)) -> None:
    """The write boundary before an admin route's role check: off the desktop
    a write is refused as a human action, whatever the caller's role."""
    if principal.surface is not Surface.desktop:
        authorize(request.method, principal, request.url.path)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Metis API", version="0.1.0", lifespan=lifespan)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(StarletteHTTPException, http_error)
    # Added before CORS, so CORS wraps it and a 413 still carries its headers.
    app.add_middleware(BodyLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # /health stays public — Docker's healthcheck hits it with no token.
    app.include_router(health.router)
    # Domain routers: viewer reads (GET), editor/admin writes (enforced per method).
    rbac = [Depends(enforce_rbac)]
    app.include_router(goals.router, dependencies=rbac)
    app.include_router(capabilities.router, dependencies=rbac)
    app.include_router(products.router, dependencies=rbac)
    app.include_router(work.router, dependencies=rbac)
    app.include_router(features.router, dependencies=rbac)
    app.include_router(journeys.router, dependencies=rbac)
    app.include_router(graph.router, dependencies=rbac)
    app.include_router(strategies.router, dependencies=rbac)
    app.include_router(tech.router, dependencies=rbac)
    app.include_router(stacks.router, dependencies=rbac)
    # Reads too are editor-only: guesses are for the people who confirm them.
    app.include_router(guesses.router, dependencies=[*rbac, Depends(require_editor)])
    # The six questions, in the shared envelope. Registered after the CRUD
    # routers so their static paths win where the two overlap.
    app.include_router(questions.router, dependencies=rbac)
    app.include_router(governance.constraints_router, dependencies=rbac)
    app.include_router(governance.concerns_router, dependencies=rbac)
    app.include_router(chat.router, dependencies=rbac)
    # Global lists the domain routers never grew: the two join tables (whose own
    # ids nothing else exposes) and tickets across products. Ordinary reads.
    app.include_router(admin_data.rows_router, dependencies=rbac)
    # Admin-only: user management and LLM provider config. Both gates, for the
    # same reason as the cascade below: require_admin alone would leave these
    # writes reachable from an api/mcp token (test_route_gates sweeps for it).
    # The surface goes first, as on every other write: off the desktop no role
    # would help, so a write there hears human_action_required, not "Requires
    # admin role". On the desktop a viewer still hears that it needs admin.
    admin_only = [Depends(surface_first), Depends(require_admin), Depends(enforce_rbac)]
    app.include_router(users.router, dependencies=admin_only)
    app.include_router(admin_llm.router, dependencies=admin_only)
    # Cascade delete gets BOTH gates. require_admin checks role only, so mounting
    # it with require_admin alone would make it the one write path an api/mcp
    # token could reach — see test_writes_blocked_off_desktop_even_for_admin.
    # Preview is a POST and is therefore desktop-only too; that is intended, not
    # an oversight.
    app.include_router(admin_data.cascade_router, dependencies=admin_only)
    return app


app = create_app()
