import time

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.llm.anthropic_provider import AnthropicProvider
from app.llm.base import NoProviderError
from app.llm.openai_compat import OpenAICompatProvider
from app.llm.types import ProviderStatus
from app.models import AgentLLMConfig

STATUS_TTL_SECONDS = 30


class ProviderRegistry:
    def __init__(self, settings: Settings):
        self._settings = settings
        self.providers = {
            p.name: p
            for p in [
                AnthropicProvider(settings),
                OpenAICompatProvider(
                    "openai",
                    "OpenAI API",
                    api_key_getter=lambda: settings.openai_api_key,
                    models_getter=lambda: _split(settings.openai_models),
                ),
                OpenAICompatProvider(
                    "openrouter",
                    "OpenRouter",
                    api_key_getter=lambda: settings.openrouter_api_key,
                    base_url="https://openrouter.ai/api/v1",
                    models_getter=lambda: _split(settings.openrouter_models),
                ),
                AnthropicProvider(settings, bedrock=True),
                OpenAICompatProvider(
                    "ollama",
                    "Ollama (local)",
                    api_key_getter=lambda: "",
                    ollama_base_getter=lambda: settings.ollama_base_url,
                ),
            ]
        }
        self._statuses: list[ProviderStatus] | None = None
        self._statuses_at = 0.0

    async def statuses(self, force: bool = False) -> list[ProviderStatus]:
        now = time.monotonic()
        if force or self._statuses is None or now - self._statuses_at > STATUS_TTL_SECONDS:
            self._statuses = [await p.detect() for p in self.providers.values()]
            self._statuses_at = now
        return self._statuses

    async def resolve_for_agent(self, session: AsyncSession, agent_name: str):
        """Returns (provider, model) for an agent, or raises NoProviderError."""
        config = await session.get(AgentLLMConfig, agent_name)
        if config is None:
            raise NoProviderError(
                f"No LLM configured for agent `{agent_name}`. Set one in LLM Config."
            )
        provider = self.providers.get(config.provider)
        if provider is None:
            raise NoProviderError(f"Unknown provider `{config.provider}` for `{agent_name}`.")
        status = next((s for s in await self.statuses() if s.name == provider.name), None)
        if status is None or not status.available:
            hint = status.detail if status and status.detail else "no credentials found"
            raise NoProviderError(
                f"Provider `{config.provider}` is not available ({hint}). "
                "Configure it in .env or pick another provider in LLM Config."
            )
        return provider, config.model


def _split(raw: str) -> list[str]:
    return [m.strip() for m in raw.split(",") if m.strip()]
