import time
from collections.abc import AsyncIterator
from typing import Any, Protocol

from app.llm.types import LLMEvent, ProviderStatus, ToolDef

LIVE_MODELS_TTL_SECONDS = 300


class NoProviderError(Exception):
    """Raised when an agent's configured provider is unavailable."""


def order_models(curated: list[str], live: list[str]) -> list[str]:
    """Live model ids, curated defaults first so dropdowns keep a sane default pick."""
    live_set = set(live)
    head = [m for m in curated if m in live_set]
    return head + sorted(live_set.difference(head))


class LiveModelCache:
    """Remembers a provider's live model listing — or its failure — for a short TTL,
    so status polling doesn't hammer remote list-models endpoints."""

    def __init__(self, ttl: float = LIVE_MODELS_TTL_SECONDS):
        self._ttl = ttl
        self._at: float | None = None
        self._models: list[str] | None = None

    async def get(self, fetch) -> list[str] | None:
        now = time.monotonic()
        if self._at is None or now - self._at > self._ttl:
            try:
                self._models = await fetch()
            except Exception:
                self._models = None
            self._at = now
        return self._models


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
