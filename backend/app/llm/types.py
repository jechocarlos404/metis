"""Provider-agnostic chat types.

Normalized message dicts flow through the agent runner and are converted to
each provider's wire format inside the provider adapter:
    {"role": "user", "content": str}
    {"role": "assistant", "content": str, "tool_calls": [{"id", "name", "arguments"}]}
    {"role": "tool", "tool_call_id": str, "name": str, "content": str}
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class TextDelta:
    text: str


@dataclass
class ToolCallEvent:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class StreamDone:
    stop_reason: str | None = None


@dataclass
class StreamError:
    message: str


LLMEvent = TextDelta | ToolCallEvent | StreamDone | StreamError


@dataclass
class ProviderStatus:
    name: str
    label: str
    available: bool
    detail: str | None = None
    models: list[str] = field(default_factory=list)
