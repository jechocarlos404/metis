import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import TokenVerifier, enforce_rbac, require_admin, require_editor
from app.config import get_settings
from app.db import init_db, make_engine
from app.llm.registry import ProviderRegistry
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


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Metis API", version="0.1.0", lifespan=lifespan)
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
    # Admin-only: user management and LLM provider config.
    admin_only = [Depends(require_admin)]
    app.include_router(users.router, dependencies=admin_only)
    app.include_router(admin_llm.router, dependencies=admin_only)
    # Cascade delete gets BOTH gates. require_admin checks role only, so mounting
    # it admin_only alone would make it the one write path an api/mcp token could
    # reach — see test_writes_blocked_off_desktop_even_for_admin. Preview is a
    # POST and is therefore desktop-only too; that is intended, not an oversight.
    app.include_router(
        admin_data.cascade_router,
        dependencies=[Depends(require_admin), Depends(enforce_rbac)],
    )
    return app


app = create_app()
