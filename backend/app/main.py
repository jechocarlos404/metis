from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import TokenVerifier, enforce_rbac, require_admin
from app.config import get_settings
from app.db import init_db, make_engine
from app.llm.registry import ProviderRegistry
from app.routers import (
    admin_llm,
    capabilities,
    chat,
    features,
    goals,
    graph,
    health,
    products,
    strategies,
    users,
    work,
)
from app.services.graph_service import FeatureGraph
from app.services.seed import seed_demo_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine, sessionmaker = make_engine(settings.database_url)
    app.state.engine = engine
    app.state.sessionmaker = sessionmaker
    await init_db(engine)
    if settings.seed_demo_data:
        await seed_demo_data(sessionmaker)
    app.state.graph = FeatureGraph(sessionmaker)
    await app.state.graph.load()
    app.state.llm = ProviderRegistry(settings)
    app.state.verifier = TokenVerifier(settings) if settings.auth_enabled else None
    yield
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
    app.include_router(graph.router, dependencies=rbac)
    app.include_router(strategies.router, dependencies=rbac)
    app.include_router(chat.router, dependencies=rbac)
    # Admin-only: user management and LLM provider config.
    admin_only = [Depends(require_admin)]
    app.include_router(users.router, dependencies=admin_only)
    app.include_router(admin_llm.router, dependencies=admin_only)
    return app


app = create_app()
