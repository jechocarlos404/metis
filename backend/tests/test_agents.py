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
    # An approved link's outcome shows on the card: no UUID in it.
    assert summarize_result('{"edge_id": "bc55de64-3d5a-4934-b404-b0945c6e2492", "kind": "BLOCKS"}') == "kind: BLOCKS"
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


# ---- what the owner reads: plain words, names, the product page's numbers ----

UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def chat_client(db):
    from httpx import ASGITransport, AsyncClient

    from app.config import Settings, get_settings
    from app.db import get_db
    from app.main import create_app

    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_the_approval_card_names_the_goal_not_its_uuid(db):
    """A5: the agent passed UUIDs; the card shows the goal's code and title and
    the parent's name. A capability an earlier change in the reply creates is
    shown by the name given, and `arguments` stay what approval will run."""
    import re

    from app.models import Goal
    from app.schemas.capability import CapabilityCreate
    from app.services import capabilities as capability_service

    async with db() as session:
        goal = Goal(goal_type="product", title="Plan café stops on every ride")
        session.add(goal)
        await session.commit()
        goal_id, code = str(goal.id), f"PG-{goal.seq:02d}"
        crawl = await capability_service.create_capability(session, CapabilityCreate(name="Cafe Crawl Planning"))
        crawl_id = str(crawl.id)
    provider = FakeProvider([
        [ToolCallEvent(id="tc-1", name="create_capability",
                       arguments={"name": "Ride Café Stops", "parent": crawl_id, "maturity": "planned"}),
         StreamDone("tool_use")],
        call("motivate_capability", goal=goal_id, capability="Ride Café Stops"),
        text("Proposed 2 changes."),
    ])
    _, messages = await turn(db, FakeRegistry({"feature_manager": provider}), "add a capability and link it to a goal")
    path = f"/api/chat/threads/{messages[0].thread_id}/messages"
    async with chat_client(db) as http:
        rows = (await http.get(path)).json()
    create, motivate = rows[-1]["proposals"]
    assert create["named_arguments"] == {"name": "Ride Café Stops", "parent": "Cafe Crawl Planning", "maturity": "planned"}
    assert motivate["named_arguments"] == {"goal": f"{code} Plan café stops on every ride", "capability": "Ride Café Stops"}
    assert motivate["arguments"]["goal"] == goal_id  # what approval runs is untouched
    assert not re.search(UUID_RE, str([p["named_arguments"] for p in rows[-1]["proposals"]]))

    # Approved, the card still names the same things.
    await proposals.approve_all(db, GRAPH, messages[-1].id)
    async with chat_client(db) as http:
        rows = (await http.get(path)).json()
    assert [p["status"] for p in rows[-1]["proposals"]] == ["applied", "applied"]
    assert rows[-1]["proposals"][1]["named_arguments"]["goal"] == f"{code} Plan café stops on every ride"


@pytest.mark.asyncio
async def test_named_arguments_cover_features_products_tickets_and_prd_pins(db):
    from app.agents.proposals import named_arguments
    from app.schemas.capability import CapabilityCreate
    from app.schemas.feature import FeatureCreate
    from app.services import capabilities as capability_service
    from app.services import features as feature_service

    async with db() as session:
        maps = await capability_service.create_capability(session, CapabilityCreate(name="Interactive Maps"))
        product = Product(slug="atlas", name="Atlas", summary="s")
        session.add(product)
        await session.commit()
        plan = await feature_service.create_feature(session, FeatureCreate(name="Plan a route", capability_ids=[maps.id]))
        show = await feature_service.create_feature(session, FeatureCreate(name="Show the map", capability_ids=[maps.id]))
        ticket = Ticket(product_id=product.id, title="Wire the map")
        session.add(ticket)
        await session.commit()

        link = {"src": str(plan.id), "dst": str(show.id), "kind": "DEPENDS_ON"}
        assert await named_arguments(session, "link_features", link, set()) == {
            "src": "Plan a route", "dst": "Show the map", "kind": "DEPENDS_ON",
        }
        new = {"name": "Zoom", "product": str(product.id), "capabilities": [str(maps.id), "interactive-maps", "Not Yet"]}
        named = await named_arguments(session, "create_feature", new, set())
        assert named["product"] == "Atlas"
        assert named["capabilities"] == ["Interactive Maps", "Interactive Maps", "Not Yet"]
        named = await named_arguments(session, "update_ticket", {"ticket": f"TKT-{ticket.seq}", "status": "done"}, set())
        assert named["ticket"] == f"TKT-{ticket.seq:04d} Wire the map"
        epic = {"title": "E", "capability": str(maps.id), "stories": [{"title": "S", "feature": str(plan.id)}]}
        prd = {"product": str(product.id), "document": {"epics": [epic]}}
        named = await named_arguments(session, "create_prd_draft", prd, set())
        assert named["product"] == "Atlas"
        assert named["document"]["epics"][0]["capability"] == "Interactive Maps"
        assert named["document"]["epics"][0]["stories"][0]["feature"] == "Plan a route"
        assert epic["capability"] == str(maps.id)  # the arguments themselves are not touched


@pytest.mark.asyncio
async def test_existing_product_coverage_says_what_the_product_page_says(db):
    """A6: the model gets the page's four groups, ranking and closest products
    in the page's words, as text to quote, not JSON to do its own sums over."""
    import re

    from app.agents.tools import ToolContext, execute_tool
    from app.models import CapabilityMaturity, WorkStatus
    from app.schemas.capability import CapabilityCreate
    from app.schemas.feature import FeatureCreate
    from app.services import capabilities as capability_service
    from app.services import features as feature_service

    async with db() as session:
        async def cap(name, maturity=CapabilityMaturity.planned):
            return await capability_service.create_capability(session, CapabilityCreate(name=name, maturity=maturity))

        maps, geo = await cap("Maps", CapabilityMaturity.ga), await cap("Geocoding", CapabilityMaturity.beta)
        route, heat = await cap("Route Planning"), await cap("Heatmaps")
        atlas = Product(slug="atlas", name="Atlas", summary="s")
        rival = Product(slug="rival", name="Rival", summary="s", external=True)
        session.add_all([atlas, rival])
        await session.commit()

        async def feature(name, product, caps, unknown=False, status=WorkStatus.pending):
            await feature_service.create_feature(session, FeatureCreate(
                name=name, product_id=product.id, capability_ids=[c.id for c in caps],
                unknown_capabilities=unknown, status=status,
            ))

        await feature("Show the map", atlas, [maps, geo], status=WorkStatus.done)
        await feature("Find a place", rival, [maps, geo])
        await feature("Switch layers", rival, [maps], unknown=True)
        await feature("Plan a route", rival, [maps, route], unknown=True)
        await feature("Plan offline", rival, [route, heat], unknown=True)
        await feature("Live beacon", rival, [], unknown=True)

        ctx = ToolContext(session=session, graph=GRAPH)
        out = (await execute_tool("feature_manager", "existing_product_coverage", {"product": "Rival"}, ctx)).result

    lines = out.splitlines()
    assert lines[0] == "Rival: 5 features — 1 buildable, 1 partly known, 2 missing, 1 not described."
    assert summarize_result(out) == lines[0]  # what "What it did" shows
    assert lines[1] == "We have 2 of the 4 capabilities needed · 2 proven (beta or stable)"
    for expected in [
        "1 partly known — everything named so far is ours, but the list is incomplete.",
        "- Switch layers (named: Maps)",
        "All 2 also have capabilities nobody has named yet, so adding what's named may not be enough.",
        "- Plan offline (we don't have: Route Planning, Heatmaps)",
        "1 not described — nobody has named the capabilities it needs yet.",
        "2 capabilities we don't have, most useful first:",
        "1. Route Planning · needed by 2 features; adding it covers everything named for 1 of them · in no other product",
        "2. Heatmaps · needed by 1 feature · in no other product",
        "- Atlas has 2 of the 4 capabilities Rival's features name",
    ]:
        assert expected in lines, expected
    assert "is not \"buildable\"" in out
    assert not re.search(UUID_RE, out)
    assert "not_described" not in out and "only_gap" not in out and "ga" not in out.split()


def test_chat_verdict_words_are_the_product_pages():
    """The coverage text and the prompts use words.js's verdict words."""
    import pathlib
    import re

    from app.agents.prompts import AGENT_PROMPTS, PROPOSALS_NOTE, SYNTHESIS_PROMPT
    from app.agents.tools import VERDICT

    words = pathlib.Path(__file__).resolve().parents[2] / "frontend/src/lib/words.js"
    if not words.exists():
        pytest.skip("frontend not checked out")
    source = words.read_text()
    for key, (label, hint) in VERDICT.items():
        js_key = "unknown" if key == "not_described" else key
        found = re.search(rf'^\s*{js_key}: \{{ label: "([^"]+)", tone: "[^"]+", hint: "([^"]+)" \}}', source, re.M)
        assert found and found.groups() == (label, hint), key
        for prompt in AGENT_PROMPTS.values():
            assert label in prompt
    assert 'ga: "stable"' in source
    for prompt in AGENT_PROMPTS.values():
        assert "ga -> stable" in prompt and "Never put tool names" in prompt
    assert "never the tool name" in PROPOSALS_NOTE and "no tool names" in SYNTHESIS_PROMPT
