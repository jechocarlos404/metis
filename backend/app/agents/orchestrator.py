"""Routes each user message to one specialist agent.

Deterministic keyword table first (works with zero providers configured),
LLM one-shot classification second, spec_decomposer as the default.
"""

import json
import re

from app.agents.prompts import ORCHESTRATOR_PROMPT, PLAN_PROMPT
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


MAX_TASKS = 3


def _parse_plan(text: str, message: str) -> list[tuple[str, str]]:
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start : end + 1])
    tasks: list[tuple[str, str]] = []
    for item in data.get("tasks", []):
        agent = str(item.get("agent", "")).strip()
        task = " ".join(str(item.get("task", "")).split())[:1000]
        if agent in AGENTS and agent not in {a for a, _ in tasks}:
            tasks.append((agent, task or message))
    return tasks[:MAX_TASKS]


async def plan(message: str, registry, session) -> list[tuple[str, str]]:
    """Split a request into (agent, task) pairs to run in parallel. Falls back
    to routing the whole message to one agent when no model can plan, or the
    plan is unusable."""
    try:
        provider, model = await registry.resolve_for_agent(session, "orchestrator")
        text = ""
        async for event in provider.stream(model, PLAN_PROMPT, [{"role": "user", "content": message[:4000]}]):
            if isinstance(event, TextDelta):
                text += event.text
            elif isinstance(event, StreamError):
                raise ValueError(event.message)
        tasks = _parse_plan(text, message)
        if tasks:
            # One task: the agent gets the user's own words, not a paraphrase.
            return [(tasks[0][0], message)] if len(tasks) == 1 else tasks
    except Exception:
        pass
    return [(await route(message, registry, session), message)]
