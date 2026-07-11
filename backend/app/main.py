from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db, make_engine
from app.llm.registry import ProviderRegistry
from app.routers import admin_llm, features, goals, graph, health, products, strategies, work
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
    app.include_router(health.router)
    app.include_router(goals.router)
    app.include_router(products.router)
    app.include_router(work.router)
    app.include_router(features.router)
    app.include_router(graph.router)
    app.include_router(strategies.router)
    app.include_router(admin_llm.router)
    return app


app = create_app()
