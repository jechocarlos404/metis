from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(url, pool_pre_ping=True)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


#: `create_all` creates missing tables; it never alters an existing one. There
#: is no Alembic here, so a column added to a table that already exists needs
#: its own idempotent step. Written to be safe on a fresh database (where
#: `create_all` has already made the column) and on a live one (where it has
#: not) — every statement is IF NOT EXISTS or filtered to NULLs.
#: One statement per entry — asyncpg refuses multi-command strings.
_SLUG_BACKFILL = (
    "alter table {table} add column if not exists slug text",
    """update {table} set slug = nullif(trim(both '-' from
            lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), '')
        where slug is null""",
    # Two rows may legitimately share a name; the older seq keeps the bare slug.
    """update {table} c set slug = c.slug || '-' || c.seq
        where exists (select 1 from {table} o
                       where o.slug = c.slug and o.id <> c.id and o.seq < c.seq)""",
    "update {table} set slug = '{fallback}-' || seq where slug is null",
    "create unique index if not exists ux_{table}_slug on {table} (slug)",
    "alter table {table} alter column slug set not null",
)


#: Flags added after their tables existed. Same rules as above: idempotent,
#: one statement each, defaulting every existing row to the old meaning.
_FLAG_COLUMNS = (
    "alter table products add column if not exists external boolean not null default false",
    "alter table features add column if not exists unknown_capabilities boolean not null default false",
)


async def init_db(engine: AsyncEngine) -> None:
    from app import models  # noqa: F401 — register all tables on Base

    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(Base.metadata.create_all)
        for table, fallback in (("capabilities", "capability"), ("products", "product")):
            for statement in _SLUG_BACKFILL:
                await conn.execute(
                    text(statement.format(table=table, fallback=fallback))
                )
        for statement in _FLAG_COLUMNS:
            await conn.execute(text(statement))


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.sessionmaker() as session:
        yield session
