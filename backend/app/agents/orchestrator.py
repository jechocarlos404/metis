"""Routes each user message to one specialist agent.

Deterministic keyword table first (works with zero providers configured),
LLM one-shot classification second, spec_decomposer as the default.
"""

import re

from app.agents.prompts import ORCHESTRATOR_PROMPT
from app.llm.base import NoProviderError
from app.llm.types import StreamError, TextDelta

AGENTS = ["spec_decomposer", "feature_manager", "graph_agent", "strategist"]

# Checked in order; first hit wins — stems, not whole words, so "decompose"
# matches "decompos". graph_agent before feature_manager so "what depends on X"
# routes to traversal, not CRUD.
_KEYWORD_TABLE: list[tuple[str, str]] = [
    (r"\b(impact|blast|breaks|depends on|topo|build order|cycle|travers|dependency order"
     r"|rollup|why does|provenance|ready|health)", "graph_agent"),
    (r"\b(priorit|rice\b|moscow|strateg|phase|phasing|sequenc|roadmap|rank)", "strategist"),
    (r"\b(decompos|specs?\b|prd|epic|stor(?:y|ies)|ticket|split|break .{0,12}down)", "spec_decomposer"),
    (r"\b(feature|capabilit|maturity|realiz|motivat|link|edge|relat|semantic|library)", "feature_manager"),
]


def route_by_keywords(message: str) -> str | None:
    lowered = message.lower()
    for pattern, agent in _KEYWORD_TABLE:
        if re.search(pattern, lowered):
            return agent
    return None


async def route(message: str, registry, session) -> str:
    agent = route_by_keywords(message)
    if agent:
        return agent
    try:
        provider, model = await registry.resolve_for_agent(session, "orchestrator")
        text = ""
        async for event in provider.stream(
            model, ORCHESTRATOR_PROMPT, [{"role": "user", "content": message[:2000]}]
        ):
            if isinstance(event, TextDelta):
                text += event.text
            elif isinstance(event, StreamError):
                return "spec_decomposer"
        candidate = text.strip().split()[-1].strip("`.").lower() if text.strip() else ""
        if candidate in AGENTS:
            return candidate
    except NoProviderError:
        pass
    except Exception:
        pass
    return "spec_decomposer"
