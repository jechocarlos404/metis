import pytest_asyncio
from sqlalchemy import text

from app.db import Base, make_engine

ADMIN_URL = "postgresql+asyncpg://metis:metis@localhost:5432/postgres"
TEST_URL = "postgresql+asyncpg://metis:metis@localhost:5432/metis_test"


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    admin_engine, _ = make_engine(ADMIN_URL)
    async with admin_engine.connect() as conn:
        await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.execute(text("DROP DATABASE IF EXISTS metis_test"))
        await conn.execute(text("CREATE DATABASE metis_test"))
    await admin_engine.dispose()

    engine, sessionmaker = make_engine(TEST_URL)
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(Base.metadata.create_all)
    yield engine, sessionmaker
    await engine.dispose()


@pytest_asyncio.fixture
async def db(test_engine):
    """Function-scoped: truncates all tables between tests."""
    engine, sessionmaker = test_engine
    async with engine.begin() as conn:
        tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
        await conn.execute(text(f"TRUNCATE {tables} CASCADE"))
    yield sessionmaker
