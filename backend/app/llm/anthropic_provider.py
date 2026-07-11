from collections.abc import AsyncIterator
from typing import Any

import anthropic

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


def to_anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            blocks: list[dict[str, Any]] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                blocks.append(
                    {"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["arguments"]}
                )
            out.append({"role": "assistant", "content": blocks or m.get("content", "")})
        elif m["role"] == "tool":
            result_block = {
                "type": "tool_result",
                "tool_use_id": m["tool_call_id"],
                "content": m["content"],
            }
            # Consecutive tool results merge into one user turn.
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(result_block)
            else:
                out.append({"role": "user", "content": [result_block]})
    return out


class AnthropicProvider:
    """Claude via the Anthropic API, or via AWS Bedrock (Mantle client)."""

    def __init__(self, settings, bedrock: bool = False):
        self._settings = settings
        self._bedrock = bedrock
        self.name = "bedrock" if bedrock else "anthropic"
        self.label = "AWS Bedrock (Claude)" if bedrock else "Anthropic API"

    def _models(self) -> list[str]:
        raw = self._settings.bedrock_models if self._bedrock else self._settings.anthropic_models
        return [m.strip() for m in raw.split(",") if m.strip()]

    async def detect(self) -> ProviderStatus:
        if self._bedrock:
            s = self._settings
            available = bool(s.aws_access_key_id and s.aws_secret_access_key and s.aws_region)
            detail = None if available else "Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION"
        else:
            available = bool(self._settings.anthropic_api_key)
            detail = None if available else "Set ANTHROPIC_API_KEY"
        return ProviderStatus(
            name=self.name,
            label=self.label,
            available=available,
            detail=detail,
            models=self._models() if available else self._models(),
        )

    def _client(self):
        if self._bedrock:
            return anthropic.AsyncAnthropicBedrockMantle(
                aws_region=self._settings.aws_region,
                aws_access_key=self._settings.aws_access_key_id,
                aws_secret_key=self._settings.aws_secret_access_key,
            )
        return anthropic.AsyncAnthropic(api_key=self._settings.anthropic_api_key)

    async def stream(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[ToolDef] | None = None,
    ) -> AsyncIterator[LLMEvent]:
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": to_anthropic_messages(messages),
        }
        if tools:
            kwargs["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in tools
            ]
        try:
            client = self._client()
            async with client.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    yield TextDelta(text)
                final = await stream.get_final_message()
            for block in final.content:
                if block.type == "tool_use":
                    yield ToolCallEvent(id=block.id, name=block.name, arguments=dict(block.input))
            yield StreamDone(final.stop_reason)
        except anthropic.APIStatusError as e:
            yield StreamError(f"{self.label}: {e.message}")
        except Exception as e:
            yield StreamError(f"{self.label}: {e}")
