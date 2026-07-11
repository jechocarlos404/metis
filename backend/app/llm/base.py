from collections.abc import AsyncIterator
from typing import Any, Protocol

from app.llm.types import LLMEvent, ProviderStatus, ToolDef


class NoProviderError(Exception):
    """Raised when an agent's configured provider is unavailable."""


class LLMProvider(Protocol):
    name: str
    label: str

    async def detect(self) -> ProviderStatus: ...

    def stream(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[ToolDef] | None = None,
    ) -> AsyncIterator[LLMEvent]: ...
