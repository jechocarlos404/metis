from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import AgentLLMConfig
from app.schemas.llm import AgentConfigRead, AgentConfigUpdate, ProviderStatus
from app.services.seed import AGENT_NAMES

router = APIRouter(prefix="/api/admin/llm", tags=["llm-admin"])


@router.get("/providers", response_model=list[ProviderStatus])
async def list_providers(request: Request, force: bool = False):
    registry = request.app.state.llm
    return await registry.statuses(force=force)


@router.get("/configs", response_model=list[AgentConfigRead])
async def list_configs(session: AsyncSession = Depends(get_db)):
    return (
        await session.scalars(select(AgentLLMConfig).order_by(AgentLLMConfig.agent_name))
    ).all()


@router.put("/configs/{agent_name}", response_model=AgentConfigRead)
async def update_config(
    agent_name: str,
    data: AgentConfigUpdate,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    if agent_name not in AGENT_NAMES:
        raise HTTPException(404, f"Unknown agent `{agent_name}`")
    registry = request.app.state.llm
    if data.provider not in registry.providers:
        raise HTTPException(422, f"Unknown provider `{data.provider}`")
    config = await session.get(AgentLLMConfig, agent_name)
    if config is None:
        config = AgentLLMConfig(agent_name=agent_name, provider=data.provider, model=data.model)
        session.add(config)
    else:
        config.provider = data.provider
        config.model = data.model
    await session.commit()
    await session.refresh(config)
    return config
