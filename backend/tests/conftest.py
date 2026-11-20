import os
import re

import pytest_asyncio
from sqlalchemy import text

from app.db import Base, make_engine

# Parallel runs each set their own METIS_TEST_DB. The name must start with
# metis_test: this fixture drops it, so a typo must never reach `metis`.
TEST_DB = os.environ.get("METIS_TEST_DB", "metis_test")
if not re.fullmatch(r"metis_test\w*", TEST_DB):
    raise RuntimeError(f"METIS_TEST_DB must start with metis_test, got {TEST_DB!r}")

ADMIN_URL = "postgresql+asyncpg://metis:metis@localhost:5432/postgres"
TEST_URL = f"postgresql+asyncpg://metis:metis@localhost:5432/{TEST_DB}"


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    admin_engine, _ = make_engine(ADMIN_URL)
    async with admin_engine.connect() as conn:
        await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB}"))
        await conn.execute(text(f"CREATE DATABASE {TEST_DB}"))
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
