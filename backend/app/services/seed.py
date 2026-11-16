"""Startup defaults. Metis holds only real data — what a seed file exported
from an actual repository says exists — so nothing domain-shaped is created
here. Only the per-agent LLM settings get defaults, which admins then edit."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import AgentLLMConfig

AGENT_NAMES = ["orchestrator", "spec_decomposer", "feature_manager", "graph_agent", "strategist"]
DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-opus-4-8"


async def ensure_agent_configs(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    async with sessionmaker() as session:
        existing = set(await session.scalars(select(AgentLLMConfig.agent_name)))
        missing = [name for name in AGENT_NAMES if name not in existing]
        for name in missing:
            session.add(
                AgentLLMConfig(agent_name=name, provider=DEFAULT_PROVIDER, model=DEFAULT_MODEL)
            )
        if missing:
            await session.commit()
