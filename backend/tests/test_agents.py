"""Agent runner tests with a scripted FakeProvider — no real LLM calls."""

import pytest

from app.agents.runner import run_turn
from app.llm.base import NoProviderError
from app.llm.types import ProviderStatus, StreamDone, TextDelta, ToolCallEvent
from app.models import AgentLLMConfig, ChatMessage, ChatThread, Product
from app.services.graph_service import FeatureGraph
from sqlalchemy import select


class FakeProvider:
    """Yields pre-scripted event lists, one list per stream() call."""

    name = "fake"
    label = "Fake"

    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.calls = []

    async def detect(self):
        return ProviderStatus(name="fake", label="Fake", available=True, models=["fake-1"])

    async def stream(self, model, system, messages, tools=None):
        self.calls.append({"messages": list(messages), "tools": tools})
        for event in self.scripts.pop(0):
            yield event


class FakeRegistry:
    def __init__(self, provider=None, error=None):
        self.provider = provider
        self.error = error

    async def resolve_for_agent(self, session, agent_name):
        if self.error:
            raise self.error
        return self.provider, "fake-1"


async def make_thread(sessionmaker):
    async with sessionmaker() as session:
        thread = ChatThread(title="test")
        session.add(thread)
        await session.commit()
        await session.refresh(thread)
        return thread.id


async def collect(events):
    out = []
    async for name, payload in events:
        out.append((name, payload))
    return out


@pytest.mark.asyncio
async def test_plain_text_turn(db):
    thread_id = await make_thread(db)
    provider = FakeProvider([[TextDelta("3 goals found."), StreamDone("end_turn")]])
    graph = FeatureGraph(sessionmaker=None)

    events = await collect(
        run_turn(db, graph, FakeRegistry(provider), thread_id, "decompose the spec")
    )
    names = [n for n, _ in events]
    assert names[0] == "routing"
    assert events[0][1]["agent"] == "spec_decomposer"  # keyword-routed
    assert "message_start" in names
    assert "text_delta" in names
    assert names[-1] == "message_end"
    assert events[-1][1]["message"]["content"] == "3 goals found."

    async with db() as session:
        messages = (await session.scalars(select(ChatMessage))).all()
        assert {m.role for m in messages} == {"user", "agent"}


@pytest.mark.asyncio
async def test_tool_call_turn_creates_ticket_and_viz(db):
    thread_id = await make_thread(db)
    async with db() as session:
        product = Product(name="PM Export", summary="s")
        session.add(product)
        await session.commit()
        await session.refresh(product)

    provider = FakeProvider([
        [
            TextDelta("Creating the ticket."),
            ToolCallEvent(
                id="tc1",
                name="create_ticket",
                arguments={"product": "PM Export", "title": "Wire the exporter", "context_budget": "S"},
            ),
            StreamDone("tool_use"),
        ],
        [TextDelta("1 ticket created."), StreamDone("end_turn")],
    ])
    graph = FeatureGraph(sessionmaker=None)

    events = await collect(
        run_turn(db, graph, FakeRegistry(provider), thread_id, "create a ticket for the exporter")
    )
    names = [n for n, _ in events]
    assert names.count("tool_call") == 2  # started + finished
    tool_events = [p for n, p in events if n == "tool_call"]
    assert tool_events[-1]["status"] == "finished"
    viz = [p for n, p in events if n == "viz_block"]
    assert len(viz) == 1 and viz[0]["type"] == "ticket_card"
    assert viz[0]["data"]["title"] == "Wire the exporter"
    assert viz[0]["data"]["budget"] == "S"

    # tool loop fed the result back: second call has tool message in history
    second_call = provider.calls[1]["messages"]
    assert second_call[-1]["role"] == "tool"

    final = events[-1][1]["message"]
    assert final["viz"][0]["type"] == "ticket_card"
    assert "1 ticket created." in final["content"]


@pytest.mark.asyncio
async def test_tool_error_fed_back_for_self_correction(db):
    thread_id = await make_thread(db)
    provider = FakeProvider([
        [
            ToolCallEvent(id="tc1", name="create_ticket", arguments={"product": "nope", "title": "x"}),
            StreamDone("tool_use"),
        ],
        [TextDelta("Could not find that product."), StreamDone("end_turn")],
    ])
    graph = FeatureGraph(sessionmaker=None)

    events = await collect(
        run_turn(db, graph, FakeRegistry(provider), thread_id, "make a ticket")
    )
    tool_events = [p for n, p in events if n == "tool_call"]
    assert tool_events[-1]["status"] == "failed"
    # the error was fed back and the model got a second chance
    second_call = provider.calls[1]["messages"]
    assert "error" in second_call[-1]["content"]
    assert events[-1][1]["message"]["content"] == "Could not find that product."


@pytest.mark.asyncio
async def test_no_provider_notice(db):
    thread_id = await make_thread(db)
    graph = FeatureGraph(sessionmaker=None)
    registry = FakeRegistry(error=NoProviderError("Provider `anthropic` is not available"))

    events = await collect(run_turn(db, graph, registry, thread_id, "split this ticket"))
    names = [n for n, _ in events]
    assert "text_delta" in names
    assert names[-1] == "message_end"
    assert "not available" in events[-1][1]["message"]["content"]

    async with db() as session:
        agent_messages = (
            await session.scalars(select(ChatMessage).where(ChatMessage.role == "agent"))
        ).all()
        assert len(agent_messages) == 1  # notice persisted


@pytest.mark.asyncio
async def test_keyword_routing_table(db):
    from app.agents.orchestrator import route_by_keywords

    assert route_by_keywords("what breaks if we change the export protocol?") == "graph_agent"
    assert route_by_keywords("prioritize the features with RICE") == "strategist"
    assert route_by_keywords("decompose the PM-export spec into tickets") == "spec_decomposer"
    assert route_by_keywords("add a feature for semantic search") == "feature_manager"
    assert route_by_keywords("hello there") is None


@pytest.mark.asyncio
async def test_iteration_limit(db):
    thread_id = await make_thread(db)
    looping_script = [
        [ToolCallEvent(id=f"tc{i}", name="list_goals", arguments={}), StreamDone("tool_use")]
        for i in range(6)
    ]
    provider = FakeProvider(looping_script)
    graph = FeatureGraph(sessionmaker=None)

    events = await collect(
        run_turn(db, graph, FakeRegistry(provider), thread_id, "decompose everything")
    )
    assert "iteration limit" in events[-1][1]["message"]["content"]
    assert len(provider.calls) == 6
