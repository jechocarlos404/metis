"""Background agent turns with scripted fake providers — no real LLM calls.

Each agent gets its own FakeProvider, so specialists running in parallel can't
take each other's scripts.
"""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.agents import proposals
from app.agents.runner import changes_data, mark_interrupted, start_turn, summarize_result
from app.agents.tools import AGENT_TOOLS, READ_TOOLS, WRITE_TOOLS
from app.llm.base import NoProviderError
from app.llm.types import ProviderStatus, StreamDone, TextDelta, ToolCallEvent
from app.models import ChatMessage, ChatProposal, ChatThread, Product, Ticket
from app.schemas.chat import MessageRead
from app.services.graph_service import FeatureGraph


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
        self.calls.append({"system": system, "messages": list(messages), "tools": tools})
        for event in self.scripts.pop(0):
            yield event


class FakeRegistry:
    """One provider per agent. The orchestrator has none unless given, so
    planning falls back to keyword routing."""

    def __init__(self, providers=None, error=None):
        self.providers = providers or {}
        self.error = error

    async def resolve_for_agent(self, session, agent_name):
        if self.error:
            raise self.error
        if agent_name not in self.providers:
            raise NoProviderError(f"No provider for {agent_name}")
        return self.providers[agent_name], "fake-1"


def text(t):
    return [TextDelta(t), StreamDone("end_turn")]


def call(name, **arguments):
    return [ToolCallEvent(id=f"tc-{name}", name=name, arguments=arguments), StreamDone("tool_use")]


GRAPH = FeatureGraph(sessionmaker=None)


async def turn(db, registry, content):
    async with db() as session:
        thread = ChatThread(title="test")
        session.add(thread)
        await session.commit()
        thread_id = thread.id
    runs = set()
    ids = await start_turn(db, GRAPH, registry, thread_id, content, runs)
    await asyncio.gather(*runs)
    async with db() as session:
        rows = (await session.scalars(
            select(ChatMessage)
            .where(ChatMessage.thread_id == thread_id)
            .options(selectinload(ChatMessage.proposals))
            .order_by(ChatMessage.seq)
        )).all()
    return ids, [MessageRead.model_validate(r) for r in rows]


@pytest.mark.asyncio
async def test_send_returns_at_once_and_the_reply_is_saved(db):
    provider = FakeProvider([text("3 goals found.")])
    ids, messages = await turn(db, FakeRegistry({"spec_decomposer": provider}), "decompose the spec")
    user, run, reply = messages
    assert str(user.id) == ids["user_message_id"] and user.content == "decompose the spec"
    assert str(run.id) == ids["run_id"] and run.agent_name == "orchestrator" and run.status == "done"
    assert reply.parent_id == run.id and reply.agent_name == "spec_decomposer"  # keyword-routed
    assert reply.status == "done" and reply.content == "3 goals found."
    # The specialist sees the user's message once, not twice.
    sent = provider.calls[0]["messages"]
    assert [m["content"] for m in sent].count("decompose the spec") == 1


@pytest.mark.asyncio
async def test_reads_run_and_writes_wait_for_approval(db):
    async with db() as session:
        session.add(Product(slug="pm-export", name="PM Export", summary="s"))
        await session.commit()
    provider = FakeProvider([
        call("list_products"),
        call("create_ticket", product="PM Export", title="Wire the exporter", context_budget="S"),
        text("I proposed 1 ticket; it awaits your approval."),
    ])
    _, messages = await turn(db, FakeRegistry({"spec_decomposer": provider}), "create a ticket for the exporter")
    reply = messages[-1]
    read, write = reply.tool_calls
    assert read["status"] == "finished" and read["changes"] is False and read["summary"] == "1 result"
    assert write["status"] == "proposed" and write["changes"] is True
    assert "waiting" in write["summary"]
    # The model was told the change is pending, not done.
    assert "awaiting" in provider.calls[2]["messages"][-1]["content"]
    async with db() as session:
        assert (await session.scalars(select(Ticket))).all() == []

    (proposal,) = reply.proposals
    assert proposal.status == "pending" and proposal.tool_name == "create_ticket"
    applied = await proposals.approve(db, GRAPH, proposal.id)
    assert applied.status == "applied" and applied.result.endswith(": Wire the exporter")
    async with db() as session:
        assert [t.title for t in (await session.scalars(select(Ticket))).all()] == ["Wire the exporter"]
    # A second click (or a second tab) can't apply it twice.
    with pytest.raises(proposals.ProposalConflict):
        await proposals.approve(db, GRAPH, proposal.id)


@pytest.mark.asyncio
async def test_proposals_are_decided_in_order_and_approve_all_stops_at_a_failure(db):
    async with db() as session:
        session.add(Product(slug="pm-export", name="PM Export", summary="s"))
        await session.commit()
    provider = FakeProvider([
        call("create_ticket", product="PM Export", title="First"),
        call("create_ticket", product="No such product", title="Second"),
        call("create_ticket", product="PM Export", title="Third"),
        text("Proposed three tickets."),
    ])
    _, messages = await turn(db, FakeRegistry({"spec_decomposer": provider}), "make tickets")
    first, second, third = messages[-1].proposals
    with pytest.raises(proposals.ProposalConflict, match="earlier"):
        await proposals.approve(db, GRAPH, third.id)

    decided = await proposals.approve_all(db, GRAPH, messages[-1].id)
    assert [p.status for p in decided] == ["applied", "failed"]
    async with db() as session:
        assert (await session.get(ChatProposal, third.id)).status == "pending"
        assert [t.title for t in (await session.scalars(select(Ticket))).all()] == ["First"]
    rejected = await proposals.reject(db, third.id)
    assert rejected.status == "rejected"


@pytest.mark.asyncio
async def test_parallel_specialists_and_a_combined_answer(db):
    orchestrator = FakeProvider([
        [TextDelta('{"tasks": [{"agent": "graph_agent", "task": "Find the build order."},'
                   ' {"agent": "strategist", "task": "Rank the features."}]}'), StreamDone("end_turn")],
        text("Build order first, then the ranking."),
    ])
    graph_agent = FakeProvider([text("Order: A then B.")])
    strategist = FakeProvider([text("Rank: B, A.")])
    registry = FakeRegistry({"orchestrator": orchestrator, "graph_agent": graph_agent, "strategist": strategist})
    _, messages = await turn(db, registry, "what order should we build in, and what matters most?")
    run = messages[1]
    children = [m for m in messages if m.parent_id == run.id]
    assert {(c.agent_name, c.task, c.content, c.status) for c in children} == {
        ("graph_agent", "Find the build order.", "Order: A then B.", "done"),
        ("strategist", "Rank the features.", "Rank: B, A.", "done"),
    }
    assert run.content == "Build order first, then the ranking." and run.status == "done"
    synthesis_input = orchestrator.calls[1]["messages"][0]["content"]
    assert "Order: A then B." in synthesis_input and "Rank: B, A." in synthesis_input


@pytest.mark.asyncio
async def test_no_provider_notice(db):
    registry = FakeRegistry(error=NoProviderError("Provider `anthropic` is not available"))
    _, messages = await turn(db, registry, "split this ticket")
    reply = messages[-1]
    assert reply.status == "failed" and "not available" in reply.content
    assert messages[1].status == "done"


@pytest.mark.asyncio
async def test_iteration_limit(db):
    provider = FakeProvider([call("list_goals") for _ in range(6)])
    _, messages = await turn(db, FakeRegistry({"spec_decomposer": provider}), "decompose everything")
    assert "iteration limit" in messages[-1].content
    assert len(provider.calls) == 6


@pytest.mark.asyncio
async def test_tool_error_fed_back_for_self_correction(db):
    provider = FakeProvider([call("list_features", bogus=1), text("Retried without the bad argument.")])
    _, messages = await turn(db, FakeRegistry({"feature_manager": provider}), "which features exist")
    (step,) = messages[-1].tool_calls
    assert step["status"] == "failed"
    assert "error" in provider.calls[1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_unexpected_tool_error_stays_out_of_the_thread(db, monkeypatch):
    import app.agents.runner as runner

    async def boom(*args, **kwargs):
        raise RuntimeError("password=hunter2 at db-internal:5432")

    monkeypatch.setattr(runner, "execute_tool", boom)
    provider = FakeProvider([call("list_goals"), text("Something went wrong.")])
    _, messages = await turn(db, FakeRegistry({"feature_manager": provider}), "which features exist")
    (step,) = messages[-1].tool_calls
    assert step["status"] == "failed"
    assert "hunter2" not in step["summary"] and "internal error" in step["summary"]
    assert "hunter2" not in provider.calls[1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_a_restart_leaves_no_reply_running(db):
    async with db() as session:
        thread = ChatThread(title="t")
        session.add(thread)
        await session.flush()
        session.add(ChatMessage(thread_id=thread.id, role="agent", status="running"))
        await session.commit()
    await mark_interrupted(db)
    async with db() as session:
        assert {m.status for m in (await session.scalars(select(ChatMessage))).all()} == {"interrupted"}


def test_every_tool_is_classified_as_read_or_write():
    """The approval gate trusts this list: an unlisted tool must fail here."""
    names = {d.name for tools in AGENT_TOOLS.values() for d, _ in tools}
    assert names == WRITE_TOOLS | READ_TOOLS
    assert not WRITE_TOOLS & READ_TOOLS
    assert changes_data("create_feature") and not changes_data("capability_inventory")


def test_step_summaries_read_like_a_log():
    assert summarize_result('[{"a": 1}, {"a": 2}]') == "2 results"
    assert summarize_result('{"error": "no such product"}') == "error: no such product"
    assert summarize_result('{"id": "x", "name": "Route Planning"}') == "Route Planning"
    assert summarize_result('{"product": "Strava", "total_features": 25, "buildable": [], "report": {}}') == (
        "product: Strava · total features: 25 · buildable: 0"
    )


@pytest.mark.asyncio
async def test_keyword_routing_table(db):
    from app.agents.orchestrator import route_by_keywords

    assert route_by_keywords("what breaks if we change the export protocol?") == "graph_agent"
    assert route_by_keywords("prioritize the features with RICE") == "strategist"
    assert route_by_keywords("decompose the PM-export spec into tickets") == "spec_decomposer"
    assert route_by_keywords("add a feature for semantic search") == "feature_manager"
    assert route_by_keywords("hello there") is None


@pytest.mark.asyncio
async def test_chat_status_says_whether_any_provider_answers():
    """Any role may ask whether chat can run, so the UI can say so before a
    message is typed; it learns nothing about which providers exist."""
    from httpx import ASGITransport, AsyncClient

    from app.config import Settings, get_settings
    from app.main import create_app

    class Registry:
        def __init__(self, available):
            self.available = available

        async def statuses(self, force=False):
            return [ProviderStatus(name="a", label="A", available=self.available, models=[])]

    for available in (False, True):
        app = create_app()
        app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
        app.state.llm = Registry(available)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            body = (await http.get("/api/chat/status")).json()
        assert body == {"available": available}
