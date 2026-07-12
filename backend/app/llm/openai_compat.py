import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import openai

from app.llm.base import LiveModelCache, order_models
from app.llm.types import (
    LLMEvent,
    ProviderStatus,
    StreamDone,
    StreamError,
    TextDelta,
    ToolCallEvent,
    ToolDef,
)

MAX_TOKENS = 8192

# OpenAI's /models mixes in embedding/audio/image models; keep the dropdown chat-only.
_NON_CHAT_MARKERS = (
    "embedding", "whisper", "tts", "dall-e", "moderation", "audio", "realtime",
    "transcribe", "image",
)


def to_openai_messages(system: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for m in messages:
        if m["role"] == "assistant":
            entry: dict[str, Any] = {"role": "assistant", "content": m.get("content") or None}
            if m.get("tool_calls"):
                entry["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])},
                    }
                    for tc in m["tool_calls"]
                ]
            out.append(entry)
        elif m["role"] == "tool":
            out.append(
                {"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]}
            )
        else:
            out.append({"role": "user", "content": m["content"]})
    return out


class OpenAICompatProvider:
    """OpenAI, OpenRouter, and Ollama — all speak the chat-completions protocol."""

    def __init__(
        self,
        name: str,
        label: str,
        api_key_getter,
        base_url: str | None = None,
        models_getter=None,
        ollama_base_getter=None,
    ):
        self.name = name
        self.label = label
        self._api_key = api_key_getter
        self._base_url = base_url
        self._models = models_getter or (lambda: [])
        self._ollama_base = ollama_base_getter
        self._live = LiveModelCache()

    @property
    def _is_ollama(self) -> bool:
        return self._ollama_base is not None

    async def detect(self) -> ProviderStatus:
        if self._is_ollama:
            base = self._ollama_base().rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=1.5) as client:
                    resp = await client.get(f"{base}/api/tags")
                    resp.raise_for_status()
                    models = sorted(m["name"] for m in resp.json().get("models", []))
                return ProviderStatus(
                    name=self.name, label=self.label, available=True, models=models,
                    detail=None if models else "Reachable, but no models pulled",
                )
            except Exception:
                return ProviderStatus(
                    name=self.name, label=self.label, available=False,
                    detail=f"Ollama not reachable at {base}",
                )
        available = bool(self._api_key())
        env_var = {"openai": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY"}.get(
            self.name, "API key"
        )
        models = self._models()
        if available:
            live = await self._live.get(self._fetch_models)
            if live:
                models = order_models(self._models(), live)
        return ProviderStatus(
            name=self.name, label=self.label, available=available,
            detail=None if available else f"Set {env_var}",
            models=models,
        )

    async def _fetch_models(self) -> list[str]:
        ids = [m.id async for m in self._client().models.list(timeout=5)]
        if self.name == "openai":
            ids = [i for i in ids if not any(marker in i for marker in _NON_CHAT_MARKERS)]
        return ids

    def _client(self) -> openai.AsyncOpenAI:
        if self._is_ollama:
            return openai.AsyncOpenAI(
                base_url=f"{self._ollama_base().rstrip('/')}/v1", api_key="ollama"
            )
        return openai.AsyncOpenAI(api_key=self._api_key(), base_url=self._base_url)

    async def stream(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[ToolDef] | None = None,
    ) -> AsyncIterator[LLMEvent]:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(system, messages),
            "stream": True,
            "max_completion_tokens": MAX_TOKENS,
        }
        if tools:
            kwargs["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in tools
            ]
        try:
            stream = await self._client().chat.completions.create(**kwargs)
            pending: dict[int, dict[str, Any]] = {}
            finish_reason = None
            async for chunk in stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if delta and delta.content:
                    yield TextDelta(delta.content)
                for tc in (delta.tool_calls or []) if delta else []:
                    slot = pending.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["arguments"] += tc.function.arguments
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
            for index in sorted(pending):
                slot = pending[index]
                try:
                    arguments = json.loads(slot["arguments"]) if slot["arguments"] else {}
                except json.JSONDecodeError:
                    arguments = {}
                yield ToolCallEvent(
                    id=slot["id"] or f"call_{index}", name=slot["name"], arguments=arguments
                )
            yield StreamDone(finish_reason)
        except openai.APIStatusError as e:
            yield StreamError(f"{self.label}: {getattr(e, 'message', str(e))}")
        except Exception as e:
            yield StreamError(f"{self.label}: {e}")
