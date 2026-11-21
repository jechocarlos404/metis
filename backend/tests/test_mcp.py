"""MCP rendering and the two stop conditions.

The renderers are pure functions over an envelope, so they test without a
server — and they are exactly where the surfaces would drift apart, because
this is the only place the shared rows get turned into something else.
"""

import json
from datetime import date, datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import AnyUrl

from app.auth import Principal, authorize
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.mcp import render, server
from app.mcp.client import MetisClient
from app.mcp.server import PROMPTS, RESOURCE_TEMPLATES, RESOURCES, TOOLS, _hard_stop
from app.models import CapabilityMaturity, Goal, GoalType, Product, TechKind, WorkStatus
from app.models.enums import Surface
from app.models.stack import TechStack
from app.schemas.capability import (
    MAX_CAPABILITY_NAME,
    MAX_IDEA_FEATURES,
    MAX_IDEA_NAMES,
    MAX_NAME,
    CapabilityCreate,
)
from app.schemas.envelope import Question
from app.schemas.feature import EdgeCreate, FeatureCreate
from app.schemas.journey import JourneyCreate, JourneyStepIn
from app.schemas.stack import ProductTechnologyWrite
from app.schemas.technology import TechnologyCreate, VersionCreate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services import journeys as journey_service
from app.services import stacks as stack_service
from app.services import technologies as tech_service
from app.services.graph_service import FeatureGraph


def envelope(question, rows, href, **extra):
    return {
        "question": question,
        "subject": {"kind": "capability", "slug": "semantic-search"},
        "answer": rows,
        "unresolved": [],
        "as_of": "2026-07-27T09:14:03Z",
        "href": href,
        **extra,
    }


SUPPLY = envelope(
    Question.capability_supply,
    [
        {"tech": "pgvector", "fit": "native", "stance": "candidate",
         "cost": {"ops_burden": 0}, "bound_in": []},
        {"tech": "qdrant", "fit": "native", "stance": "trial",
         "cost": {"ops_burden": 2}, "bound_in": ["metis::data::Vector index"]},
        {"tech": "postgresql", "fit": "workaround", "stance": "standard",
         "cost": {"ops_burden": 0}, "bound_in": []},
    ],
    "/capabilities/semantic-search",
    realizations=[
        {"feature": "Spec similarity", "product": "metis",
         "status": "in_progress", "tickets": 4}
    ],
)


INVENTORY_TOOLS = {
    "products",
    "capability_inventory",
    "check_idea",
    "product_score",
    "capability",
    "feature_why",
    "journeys",
    "ready_features",
    "recheck",
}


def test_tool_names_are_the_question_keys():
    """One vocabulary across desktop, API and MCP, or the transcripts stop
    lining up. The inventory tools are named for the job instead."""
    names = {t.name for t in TOOLS}
    assert {str(q) for q in Question} <= names
    assert names - {str(q) for q in Question} == {
        "tech_search",
        "propose_binding",
        *INVENTORY_TOOLS,
    }
    assert len(TOOLS) == 17
    assert len(RESOURCES) + len(RESOURCE_TEMPLATES) == 4
    assert len(PROMPTS) == 3


async def test_every_tool_is_listed_and_a_tech_tool_on_an_empty_catalog_says_so(api):
    """A client lists tools once, when it connects, and is never told the
    catalog filled, so a tool hidden then stays out of reach (D43). Every tool
    is listed; on an empty catalog a technology tool answers, through the
    SDK's own handlers as a client calls it, and says how one gets recorded."""
    import mcp.types as types

    listed = server.server.request_handlers[types.ListToolsRequest]
    tools = (await listed(types.ListToolsRequest(method="tools/list"))).root.tools
    assert [t.name for t in tools] == [t.name for t in TOOLS]
    assert {t.name for t in TOOLS} - INVENTORY_TOOLS == {
        "tech_search", "capability_supply", "tech_blast_radius", "tech_exposure",
        "stack_redundancy", "tech_encounters", "stack_recommend", "propose_binding",
    }
    called = server.server.request_handlers[types.CallToolRequest]
    answer = (
        await called(
            types.CallToolRequest(
                method="tools/call",
                params=types.CallToolRequestParams(name="tech_search", arguments={"q": "redis"}),
            )
        )
    ).root
    assert not answer.isError
    assert "No technology is recorded yet" in answer.content[0].text
    assert not server.server.create_initialization_options().capabilities.tools.listChanged


def test_no_tool_mutates():
    """propose_binding is a hand-off, not a mutation. Nothing else even looks
    like a write."""
    for tool in TOOLS:
        assert not any(
            verb in tool.name for verb in ("create", "update", "delete", "bind_", "set_")
        ), tool.name
    proposal = next(t for t in TOOLS if t.name == "propose_binding")
    assert "WRITES NOTHING" in proposal.description


def test_numbers_lead_and_open_is_last():
    for text in (
        render.capability_supply(SUPPLY),
        render.tech_blast_radius(
            envelope(
                Question.tech_blast_radius,
                [{"product": "metis", "layer": "data", "role": "Vector index",
                  "required": True, "off_stack": False}],
                "/tech/qdrant#blast-radius",
                alternatives=[{"tech": "pgvector", "fit": "native", "stance": "candidate"}],
            )
        ),
        render.stack_redundancy(
            envelope(Question.stack_redundancy, [], "/stacks?product=metis")
        ),
    ):
        lines = text.splitlines()
        assert lines[0][0].isdigit(), lines[0]
        assert lines[-1].startswith("Open: /"), lines[-1]


def test_blast_radius_uses_stack_words_only_for_a_slot():
    """A product with no stack isn't off anything: it just uses it, and
    required/optional say nothing about it."""
    text = render.tech_blast_radius(
        envelope(
            Question.tech_blast_radius,
            [
                {"product": "metis", "layer": "data", "role": "Vector index",
                 "required": True, "off_stack": False},
                {"product": "magpie", "layer": None, "role": None,
                 "required": False, "off_stack": True},
                {"product": "kida", "layer": None, "role": None,
                 "required": False, "off_stack": False},
            ],
            "/tech/qdrant#blast-radius",
        )
    )
    lines = text.splitlines()
    assert lines[0].endswith(" — 1 required, 1 off_stack, 1 with no stack.")
    assert lines[2].split() == ["metis", "data", "Vector", "index", "required"]
    assert lines[3].endswith("off_stack (its stack never declared it)")
    assert lines[4].endswith("uses it (the product has no stack)")
    assert "optional" not in text


def test_enums_are_verbatim():
    """`workaround`, not "partial support". A paraphrase is where the
    vocabulary drifts."""
    text = render.capability_supply(SUPPLY)
    assert "workaround" in text and "Workaround" not in text
    assert "standard" in text and "Standard" not in text


def test_render_preserves_the_envelope_order():
    """The envelope arrives ranked. A surface-specific sort is a
    surface-specific answer."""
    text = render.capability_supply(SUPPLY)
    order = [line.split()[0] for line in text.splitlines() if line[:1].isalpha()]
    assert order[:3] == ["pgvector", "qdrant", "postgresql"]


def test_bound_offer_is_marked_in_place_not_filtered():
    text = render.capability_supply(SUPPLY)
    assert "qdrant" in text
    assert "← bound in metis::data::Vector index" in text


def test_build_side_counts_only_our_features():
    """An external product's feature is set apart, never counted as ours, so
    the build side agrees with `capability`'s count of our features."""
    text = render.capability_supply(
        {**SUPPLY, "realizations": [
            {"feature": "Spec similarity", "product": "metis", "external": False,
             "status": "in_progress", "tickets": 4},
            {"feature": "Find similar routes", "product": "komoot", "external": True,
             "status": "done", "tickets": 0},
        ]}
    )
    lines = text.splitlines()
    assert "Build side — 1 feature(s) of ours realize it, any status (0 done):" in lines
    ours = lines.index("Build side — 1 feature(s) of ours realize it, any status (0 done):")
    assert lines[ours + 1].startswith("Spec similarity")
    theirs = lines.index("External products — 1 feature(s), not ours:")
    assert lines[theirs + 1].split() == ["Find", "similar", "routes", "done", "komoot"]
    assert text.endswith("Open: /capabilities/semantic-search")


def test_exposure_prints_as_of():
    """An agent quoting a stale exposure number is worse than one that says it
    does not know."""
    text = render.tech_exposure(
        envelope(
            Question.tech_exposure,
            [{"tech": "node", "version": "20", "reason": "eol_on:2026-04-30",
              "products": 3, "required_slots": 3}],
            "/tech?view=exposure",
        )
    )
    assert "as_of 2026-07-27T09:14:03Z" in text
    assert "eol_on:2026-04-30" in text


def test_unresolved_rows_are_printed_not_dropped():
    text = render.capability_supply(
        {**SUPPLY, "answer": [], "realizations": [],
         "unresolved": [{"subject": "semantic-search",
                         "reason": "no technology satisfies this capability",
                         "blocked_by": []}]}
    )
    assert "Unresolved — semantic-search: no technology satisfies" in text
    assert text.startswith("0 offer(s)")


def test_supply_labels_its_rollup_and_sets_unresolved_apart():
    """The build side counts the submap, so it says how many arrive only
    through a sub-capability, as `capability` does; and the Unresolved line
    follows a blank one, as every other section does."""
    text = render.capability_supply(
        {**SUPPLY, "answer": [], "realizations": [
            {"feature": "Sign in", "product": "metis", "external": False, "via": None,
             "status": "done", "tickets": 0},
            {"feature": "Use an authenticator", "product": "metis", "external": False,
             "via": "Multi-Factor Authentication", "status": "in_progress", "tickets": 0},
        ], "unresolved": [{"subject": "user-authentication",
                           "reason": "no technology satisfies this capability", "blocked_by": []}]}
    )
    lines = text.splitlines()
    assert (
        "Build side — 2 feature(s) of ours (1 only through its sub-capabilities) realize it, "
        "any status (1 done):"
    ) in lines
    unresolved = lines.index("Unresolved — user-authentication: no technology satisfies this capability")
    assert lines[unresolved - 1] == "" and lines[unresolved - 2].startswith("Use an authenticator")


def test_encounters_appends_the_ordering_hint():
    text = render.tech_encounters(
        envelope(
            Question.tech_encounters,
            [{"person": "dlee", "depth": "shipped", "last_at": "2025-11-02",
              "on_product": "ledger-sync"},
             {"person": "a.okafor", "depth": "touched", "last_at": "2026-03-18",
              "on_product": "metis"}],
            "/tech/qdrant#encounters",
        )
    )
    assert "Ask dlee first (shipped)." in text


@pytest.mark.parametrize(
    "envelope_in,expected_rule",
    [
        (
            {**SUPPLY, "unresolved": [
                {"subject": "s", "reason": "every offer is blocked by a constraint",
                 "blocked_by": ["CON-004"]}]},
            "CON-004",
        ),
        (
            {**SUPPLY, "answer": [
                {"tech": "neo4j", "fit": "native", "stance": "banned",
                 "cost": {}, "bound_in": []}]},
            "adoptions:neo4j",
        ),
    ],
)
def test_two_hard_stops_cite_an_id(envelope_in, expected_rule):
    """Both stop conditions trace to an id someone wrote down."""
    stop = _hard_stop(envelope_in)
    assert stop is not None
    assert expected_rule in stop
    assert stop.startswith("Stop —")


@pytest.mark.parametrize("stance", ["deprecated", "contained", "trial", None])
def test_everything_else_is_an_argument_not_a_stop(stance):
    """Returned with its rationale so the agent can lose the argument out loud
    rather than silently declining."""
    assert _hard_stop(
        {**SUPPLY, "answer": [
            {"tech": "neo4j", "fit": "workaround", "stance": stance,
             "cost": {}, "bound_in": []}]}
    ) is None


def test_no_offer_at_all_is_an_answer_not_a_stop():
    assert _hard_stop({**SUPPLY, "answer": [], "unresolved": [
        {"subject": "s", "reason": "no technology satisfies this capability",
         "blocked_by": []}]}) is None


def test_a_refused_write_is_rendered_with_its_href():
    """The API's 403 already carries the screen that can act; pass it through
    rather than swallowing it."""
    text = render.api_error(403, {"detail": {
        "error": "human_action_required",
        "message": "Binding a slot is a human action.",
        "href": "/stacks?slot=api::Auth"}}, "/stacks")
    assert "human_action_required" in text
    assert text.endswith("Open: /stacks?slot=api::Auth")


@pytest.mark.parametrize(
    "body,said",
    [
        ({"detail": "Feature not found"}, "Feature not found"),
        ({"detail": [{"loc": ["path", "feature_id"], "msg": "Input should be a valid UUID"}]},
         "path.feature_id: Input should be a valid UUID"),
        ("<html>Bad Gateway</html>", "<html>Bad Gateway</html>"),
    ],
)
def test_any_other_refusal_is_a_sentence_and_opens_the_tools_screen(body, said):
    """No dict repr, and the Open: line is there like on every answer."""
    text = render.api_error(404, body, "/features")
    assert text.splitlines() == [f"Refused (404): {said}", "Open: /features"]


@pytest.mark.parametrize(
    "hostile",
    [
        "../../admin/llm",
        "..%2f..%2fadmin",
        "qdrant/../../users",
        "qdrant?x=1",
        "http://evil.example/x",
        "",
        "Qdrant",
    ],
)
def test_resource_uris_cannot_walk_out_of_their_path(hostile):
    """Everything interpolated into a request path has to be shaped like what
    it claims to be — otherwise a resource URI addresses the rest of the API
    with this server's token."""
    from app.mcp.server import _safe_slug

    with pytest.raises(ValueError):
        _safe_slug(hostile)


def test_slot_ids_must_be_uuids():
    from app.mcp.server import _safe_id

    assert _safe_id("16ce952e-44cd-4317-9176-b3c7de518d9f")
    with pytest.raises(ValueError):
        _safe_id("../../admin")


def _sse_client(host="localhost:8001"):
    """The SSE app's middleware in front of a stub route."""
    from httpx import ASGITransport, AsyncClient
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from app.mcp.auth import sse_middleware

    app = Starlette(
        routes=[Route("/sse", lambda r: PlainTextResponse("ok"))],
        middleware=sse_middleware("s3cret"),
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url=f"http://{host}")


@pytest.mark.asyncio
async def test_sse_requires_a_bearer_token():
    """stdio inherits the launcher's identity; a listening socket inherits
    nothing, and this process holds an API token."""
    async with _sse_client() as c:
        assert (await c.get("/sse")).status_code == 401
        assert (await c.get("/sse", headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await c.get("/sse", headers={"Authorization": "Bearer s3cret"})).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host, status",
    [
        ("localhost:8001", 200),
        ("127.0.0.1:8001", 200),
        ("mcp:8001", 200),
        ("evil.example", 400),
        ("attacker.test:8001", 400),
        ("localhost.evil.example", 400),
    ],
)
async def test_sse_answers_only_loopback_and_compose_hosts(host, status):
    """DNS rebinding: a page can point its own name at 127.0.0.1, but its
    requests still carry its own Host header, so the token alone is not enough."""
    async with _sse_client(host) as c:
        assert (await c.get("/sse", headers={"Authorization": "Bearer s3cret"})).status_code == status


def test_proposal_says_it_applied_nothing():
    text = render.propose_binding(
        "metis::data::Vector index", "pgvector", "rides existing Postgres.", "/stacks?x=1"
    )
    assert "Not applied. Binding a slot is a human action." in text
    assert text.endswith("Confirm at: /stacks?x=1")


# ---- inventory tools, round-tripped through the real API ----
# Renderers alone would test against payloads written here; these drive
# _dispatch through MetisClient against the app, so a shape the API stops
# serving fails here rather than in an agent's transcript.


@pytest_asyncio.fixture
async def api(db, monkeypatch):
    """The app on the test database, and the MCP server's client pointed at it.
    Auth is off (no Keycloak in tests); the write boundary has its own tests
    below and in test_auth."""
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    metis = MetisClient(base_url="http://test")
    await metis._http.aclose()
    metis._http = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    metis._settings = Settings(auth_enabled=False)
    monkeypatch.setattr(server, "client", metis)
    yield app, db
    await metis.aclose()


async def _world(app, db):
    """One product of ours, one external, a goal, a dependency and a journey."""
    async with db() as s:
        def cap(name, maturity=CapabilityMaturity.planned, anchors=()):
            return capability_service.create_capability(
                s,
                CapabilityCreate(name=name, maturity=maturity, evidence_anchors=list(anchors)),
            )

        strava = await cap(
            "Strava import", CapabilityMaturity.ga, ["app/strava/sync.py", "app/strava/oauth.py"]
        )
        elevation = await cap("Elevation data", CapabilityMaturity.beta)
        physics = await cap("Physics model", CapabilityMaturity.alpha)
        weather = await cap("Weather forecast")
        await cap("Route planner")
        climb = Product(
            name="Can I Climb",
            slug="can-i-climb",
            seeded_at=datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc),
        )
        rival = Product(name="Rival", slug="rival", external=True)
        goal = Goal(goal_type=GoalType.product, title="Riders trust the estimate")
        s.add_all([climb, rival, goal])
        await s.commit()
        await capability_service.add_motivation(s, strava.id, goal.id)

        def feature(name, product, caps, **extra):
            return feature_service.create_feature(
                s,
                FeatureCreate(
                    name=name,
                    product_id=product.id,
                    capability_ids=[c.id for c in caps],
                    **extra,
                ),
            )

        estimate = await feature(
            "Estimate climb power", climb, [physics, elevation, strava], status=WorkStatus.done
        )
        forecast = await feature("Show ride history", climb, [strava])
        await feature_service.create_edge(
            s, EdgeCreate(src_id=forecast.id, dst_id=estimate.id)
        )
        await feature("Rival weather", rival, [weather])
        await feature("Rival map", rival, [elevation], unknown_capabilities=True)
        await feature("Rival social", rival, [], unknown_capabilities=True)
        journey = await journey_service.create_journey(
            s,
            JourneyCreate(
                name="Plan a climb",
                steps=[
                    JourneyStepIn(feature_id=estimate.id),
                    JourneyStepIn(label="Check wind", needs=["Weather forecast"]),
                ],
            ),
        )
    graph = FeatureGraph(db)
    await graph.load()
    app.state.graph = graph
    return {"forecast": forecast, "journey": journey, "climb": climb, "rival": rival}


def _conventions(text):
    lines = text.splitlines()
    assert lines[0][0].isdigit(), lines[0]
    assert lines[-1].startswith("Open: /"), lines[-1]


async def test_products_lists_ours_and_external(api):
    w = await _world(*api)
    text = await server._dispatch("products", {})
    _conventions(text)
    assert text.startswith("2 product(s): 1 ours, 1 external.")
    assert str(w["rival"].id) in text and "external" in text
    rows = {line.split()[0]: line.split()[2] for line in text.splitlines()[2:4]}
    assert rows == {"can-i-climb": "2026-11-01T12:00:00Z", "rival": "never"}


async def test_products_given_one_lists_its_features_for_the_tools_that_take_one(api):
    """No tool needed a name to list a product's features, yet feature_why
    and recheck need one. products with a product lists them, with status
    and the id the next call takes."""
    w = await _world(*api)
    text = await server._dispatch("products", {"product": "can-i-climb"})
    _conventions(text)
    lines = text.splitlines()
    assert lines[0] == "2 feature(s) of can-i-climb (ours): 1 done, 1 pending."
    rows = {line.split("  ")[1].strip(): line.split()[-2:] for line in lines[2:4]}
    assert rows["Estimate climb power"][0] == "done"
    assert rows["Show ride history"] == ["pending", str(w["forecast"].id)]
    assert lines[-1] == f"Open: /features?product={w['climb'].id}"
    why = await server._dispatch("feature_why", {"feature": rows["Show ride history"][1]})
    assert not why.startswith("0 features")

    by_id = await server._dispatch("products", {"product": str(w["rival"].id)})
    assert by_id.startswith("3 feature(s) of rival (external): 3 pending.")
    assert (await server._dispatch("products", {"product": "Rival"})).splitlines()[1] == (
        'Near names, unconfirmed: rival "Rival"'
    )
    assert (await server._dispatch("products", {})).startswith("2 product(s): 1 ours, 1 external.")


async def test_a_products_stacks_resource_holds_only_its_own_stacks(api):
    app, db = api
    w = await _world(app, db)
    async with db() as s:
        s.add_all([TechStack(name="Climb stack", product_id=w["climb"].id),
                   TechStack(name="Rival stack", product_id=w["rival"].id)])
        await s.commit()
    climb = json.loads(await server.read_resource(AnyUrl("metis://stacks/can-i-climb")))
    assert [v["stack"]["name"] for v in climb["stacks"]] == ["Climb stack"]
    with pytest.raises(ValueError, match="No product 'nobody'"):
        await server.read_resource(AnyUrl("metis://stacks/nobody"))


def row(text, slug):
    return next(line for line in text.splitlines() if line.startswith(slug + " "))


async def test_inventory_is_most_reused_first_and_filters_in_order(api):
    await _world(*api)
    text = await server._dispatch("capability_inventory", {})
    _conventions(text)
    # A capability no feature realizes isn't ours, and nobody else has it either.
    assert text.startswith("5 capabilit(ies): 3 ours, 1 only elsewhere, 1 not built yet")
    rows = [line.split()[0] for line in text.splitlines()[2:7]]
    assert rows[-2:] == ["weather-forecast", "route-planner"]
    assert "only elsewhere — not ours" in text
    assert "not built yet — not ours" in text
    # Maturity only for what is ours; route-planner is planned and unbuilt.
    assert row(text, "route-planner").split()[3] == "—"
    assert row(text, "strava-import").split()[3] == "ga"
    # Slug and exact name both: a seed file reuses a capability by its name.
    route = next(line for line in text.splitlines() if line.startswith("route-planner"))
    assert route.split("  ")[0:1] == ["route-planner"] and '"Route planner"' in route

    text = await server._dispatch("capability_inventory", {"q": "data"})
    assert text.startswith("1 of 5 capabilit(ies) match 'data'")
    text = await server._dispatch("capability_inventory", {"q": "teleport"})
    assert text.startswith("0 of 5") and "That is an answer" in text


async def test_check_idea_never_counts_a_near_name(api):
    """Ours, only elsewhere, and no match with candidates — and the candidate
    stays a candidate."""
    await _world(*api)
    text = await server._dispatch(
        "check_idea",
        {"features": [{"name": "Climb planner",
                       "capabilities": ["Strava import", "Weather forecast", "Elevaton data"]}]},
    )
    _conventions(text)
    assert text.startswith(
        "1/3 distinct capabilit(ies) are ours, 1 of them in use (beta or ga); 2 not ours."
    )
    lines = text.splitlines()
    assert any(line.strip().startswith("ours") and "strava-import (ga" in line for line in lines)
    assert any(line.strip().startswith("only elsewhere") and "rival" in line for line in lines)
    miss = next(i for i, line in enumerate(lines) if line.strip() == "no match       Elevaton data")
    assert 'near names, unconfirmed: elevation-data "Elevation data"' in lines[miss + 1]
    assert "Not ours (2): Weather forecast, Elevaton data" in text
    # Home's idea check, pre-filled: matched needs by slug, the rest as typed.
    assert lines[-1] == (
        "Open: /home?idea=Climb%20planner&caps=strava-import,weather-forecast,Elevaton%20data"
    )
    # Named, but no feature anywhere realizes it: not ours, and not "only elsewhere".
    unbuilt = await server._dispatch(
        "check_idea", {"features": [{"name": "Plan", "capabilities": ["Route planner"]}]}
    )
    assert unbuilt.startswith("0/1 distinct capabilit(ies) are ours")
    assert (
        "  not built yet  Route planner → route-planner "
        "(no finished feature realizes it) — not ours"
        in unbuilt.splitlines()
    )

    named = await server._dispatch(
        "check_idea",
        {"idea": "Climb, then eat",
         "features": [{"name": "Plan", "capabilities": ["strava-import", "Elevaton data"]},
                      {"name": "Eat", "capabilities": ["Strava import", "Food & drink"]}]},
    )
    assert named.splitlines()[-1] == (
        "Open: /home?idea=Climb%2C%20then%20eat"
        "&caps=strava-import,Elevaton%20data,Food%20%26%20drink"
    )


async def test_product_score_groups_sum_to_the_total(api):
    w = await _world(*api)
    text = await server._dispatch("product_score", {"product": "rival"})
    _conventions(text)
    assert text.startswith(
        "0/3 feature(s) of rival buildable from what we have; "
        "1 partly known, 1 not described, 1 missing a capability."
    )
    assert "Partly known" in text and "Rival map" in text
    assert "Not described" in text and "Rival social" in text
    assert "Missing a capability — names one we don't have (1): Rival weather" in text
    # Ranked gaps by slug, and the product of ours with the most of what's named.
    assert "Not ours (1), most useful first." in text
    assert "  weather-forecast  needed by 1  only_gap 1  elsewhere: none" in text.splitlines()
    assert (
        "Closest of our products, by how many of the 2 named capabilities each has built: "
        "1 can-i-climb"
    ) in text
    assert "Lower bound" in text
    assert text.endswith(f"Open: /products?product={w['rival'].id}")
    by_id = await server._dispatch("product_score", {"product": str(w["rival"].id)})
    assert by_id.startswith("0/3 feature(s) of rival buildable")
    assert (await server._dispatch("product_score", {"product": "Rival"})).startswith(
        "0 products have id or slug 'Rival'"
    )


def test_tied_closest_products_share_one_group():
    """Ties at the cut are kept whole, so more than three can come back."""
    score = {
        "product": {"id": "p", "slug": "strava"}, "total_features": 1,
        "buildable": [], "partly": [], "not_described": [], "missing": ["Kudos"],
        "missing_incomplete": [], "missing_capabilities": [],
        "report": {"existing": 2, "needed": 9, "mature": 1},
        "closest_products": [
            {"product": {"slug": s}, "capabilities": n}
            for s, n in (("hanko", 7), ("kida", 3), ("magpie", 3), ("steps", 3))
        ],
    }
    assert (
        "Closest of our products, by how many of the 9 named capabilities each has built: "
        "7 hanko; 3 kida, magpie, steps"
    ) in render.product_score(score).splitlines()


async def test_exposure_says_what_it_cannot_judge(api):
    """No end-of-life date and no maintainer count: exposure can't flag it,
    so an empty list must not read as an all-clear."""
    _, db = api
    async with db() as s:
        await tech_service.create_technology(
            s, TechnologyCreate(slug="qdrant", name="Qdrant", kind=TechKind.service)
        )
    text = await server._dispatch("tech_exposure", {})
    _conventions(text)
    assert text.startswith("0 exposed technolog(ies)")
    assert (
        "Unresolved — estate: 1 of 1 technologies have no lifecycle data (no end-of-life "
        "date, no maintainer count), so only a stance can flag them"
    ) in text.splitlines()


async def test_exposure_for_one_product_is_about_that_product(api):
    """Filtered to a product, the answer names it, says nothing about the rest
    of the estate, and its Open line keeps the product."""
    w = await _world(*api)
    _, db = api
    async with db() as s:
        dying = await tech_service.create_technology(
            s, TechnologyCreate(slug="nestjs", name="NestJS", kind=TechKind.framework)
        )
        await tech_service.create_version(
            s, dying.id, VersionCreate(label="9.0", eol_on=date.today() + timedelta(days=30))
        )
        await stack_service.record_usage(s, w["climb"].id, ProductTechnologyWrite(tech_id=dying.id))

    # Rival records no technology: nothing to judge, and not an all-clear.
    text = await server._dispatch("tech_exposure", {"product": "rival"})
    _conventions(text)
    assert text.startswith("0 exposed technolog(ies) used by rival,")
    assert "Nothing recorded reaches" not in text
    assert "nestjs" not in text and "estate" not in text
    assert (
        "Unresolved — rival: no technology is recorded as used by this product, so this "
        "says nothing about what it runs on"
    ) in text.splitlines()
    assert text.endswith("Open: /tech?view=exposure&window_days=180&product=rival")

    # Can I Climb uses the dying one.
    text = await server._dispatch("tech_exposure", {"product": str(w["climb"].id)})
    # The slot count is the technology's, over every product using it.
    assert text.startswith(
        "1 exposed technolog(ies) used by can-i-climb, 0 required slot(s) affected "
        "across every product that uses them."
    )
    assert "nestjs" in text and "Unresolved" not in text
    assert text.endswith("Open: /tech?view=exposure&window_days=180&product=can-i-climb")

    # Something it uses with no lifecycle data is counted against it alone.
    async with db() as s:
        quiet = await tech_service.create_technology(
            s, TechnologyCreate(slug="redis", name="Redis", kind=TechKind.service)
        )
        await stack_service.record_usage(s, w["rival"].id, ProductTechnologyWrite(tech_id=quiet.id))
    text = await server._dispatch("tech_exposure", {"product": "rival"})
    assert text.startswith("0 exposed technolog(ies) used by rival,")
    assert "Nothing" not in text and "estate" not in text
    assert (
        "Unresolved — rival: 1 of 1 technologies it uses have no lifecycle data (no "
        "end-of-life date, no maintainer count), so only a stance can flag them"
    ) in text.splitlines()

    # Dated far off, it is a real all-clear, for rival alone.
    async with db() as s:
        await tech_service.create_version(
            s, quiet.id, VersionCreate(label="7", eol_on=date.today() + timedelta(days=900))
        )
    text = await server._dispatch("tech_exposure", {"product": "rival"})
    _conventions(text)
    assert (
        "Nothing rival is recorded as using reaches its end of life in the window, has a "
        "deprecated or banned stance, or rests on a single maintainer."
    ) in text.splitlines()
    assert "Unresolved" not in text


async def test_redundancy_says_when_there_is_nothing_to_compare(api):
    """Redundancy compares the technologies a product records using. With
    none recorded, 0 is no finding, and it says why, as stack_recommend does."""
    w = await _world(*api)
    _, db = api
    text = await server._dispatch("stack_redundancy", {"product": "can-i-climb"})
    _conventions(text)
    assert text.startswith("0 capabilit(ies) answered more than once in can-i-climb.")
    assert (
        "Unresolved — can-i-climb: no technology is recorded as used by this product, so "
        "nothing can answer one of its capabilities twice. A seed file's technologies, or "
        "the API, record one."
    ) in text.splitlines()

    async with db() as s:
        quiet = await tech_service.create_technology(
            s, TechnologyCreate(slug="redis", name="Redis", kind=TechKind.service)
        )
        await stack_service.record_usage(s, w["climb"].id, ProductTechnologyWrite(tech_id=quiet.id))
    text = await server._dispatch("stack_redundancy", {"product": "can-i-climb"})
    assert "Unresolved" not in text
    # A technology recorded, no stack, nothing overlapping: it says what it
    # compared rather than a bare 0 (D39).
    _conventions(text)
    assert (
        "No two technologies can-i-climb uses answer the same capability natively or partly. "
        "This compares its recorded technology uses, so it needs no stack."
    ) in text.splitlines()


async def test_own_products_are_not_scored(api):
    """As on the desktop: an own product's features make its capabilities ours,
    so its score would only measure itself."""
    w = await _world(*api)
    for value in ("can-i-climb", str(w["climb"].id)):
        text = await server._dispatch("product_score", {"product": value})
        _conventions(text)
        assert text.startswith("0 features scored: can-i-climb is ours")
        assert "buildable" not in text
        assert text.endswith(f"Open: /products?product={w['climb'].id}")


async def test_capability_says_who_why_and_how_far(api):
    await _world(*api)
    text = await server._dispatch("capability", {"slug": "strava-import"})
    _conventions(text)
    assert text.startswith(
        "2 feature(s) of ours, at any status, realize strava-import across 1 product(s); "
        "maturity ga."
    )
    assert "Rollup: 2 total — 1 pending, 0 in_progress, 1 done." in text
    assert "Our products: can-i-climb" in text
    assert "PG-" in text and "Riders trust the estimate" in text
    assert "Rival weather" not in text  # external features are not ours
    assert "Evidence (2 path(s), as exported): app/strava/sync.py, app/strava/oauth.py" in text

    weather = await server._dispatch("capability", {"slug": "weather-forecast"})
    assert "Not ours: no finished feature of ours realizes it." in weather
    # Maturity describes our implementation: none shown for what isn't ours.
    assert weather.startswith(
        "0 feature(s) of ours, at any status, realize weather-forecast across 0 product(s)."
    )
    assert "External products that have it: rival" in weather
    assert "No goal motivates it directly" in weather

    assert "Evidence" not in weather  # no anchors recorded, no line

    missing = await server._dispatch("capability", {"slug": "strava"})
    assert missing.startswith("0 capabilities have slug 'strava'. Matching is exact.")
    assert "Near names, unconfirmed: strava-import" in missing


async def test_feature_why_walks_up_to_the_goal(api):
    w = await _world(*api)
    text = await server._dispatch("feature_why", {"feature": str(w["forecast"].id)})
    _conventions(text)
    assert text.startswith(
        "1 capabilit(ies) and 1 goal(s) above Show ride history (can-i-climb): "
        "0 of can-i-climb, 1 of other products."
    )
    assert "REALIZES" in text and "PG-" in text and "motivates Strava import" in text
    # can-i-climb has no goal, so no goal is called its own.
    assert "can-i-climb has no goal of its own" in text
    # By exact name too, as recheck takes it.
    assert await server._dispatch("feature_why", {"feature": "Show ride history"}) == text


async def test_feature_why_puts_the_products_own_goals_first(api):
    """A shared capability brings in other products' goals: they are labelled
    with their product, never shown as this feature's reason. Each goal says
    what it motivates, even one the chain met first as a parent."""
    app, db = api
    async with db() as s:
        def cap(name):
            return capability_service.create_capability(s, CapabilityCreate(name=name))

        strava, physics = await cap("Strava import"), await cap("Physics model")
        og_climb = Goal(goal_type=GoalType.org, title="Riders know before they ride")
        og_saddle = Goal(goal_type=GoalType.org, title="Every bike ready")
        s.add_all([og_climb, og_saddle])
        await s.flush()
        pg_climb = Goal(
            goal_type=GoalType.product, title="Trust the estimate", parent_goal_id=og_climb.id
        )
        pg_saddle = Goal(
            goal_type=GoalType.product, title="Plan the ride", parent_goal_id=og_saddle.id
        )
        s.add_all([pg_climb, pg_saddle])
        await s.flush()
        climb = Product(name="Can I Climb", slug="can-i-climb", goal_id=pg_climb.id)
        saddle = Product(name="Saddlebag", slug="saddlebag", goal_id=og_saddle.id)
        s.add_all([climb, saddle])
        await s.commit()
        for cap, goal in ((strava, pg_climb), (strava, pg_saddle), (physics, og_saddle)):
            await capability_service.add_motivation(s, cap.id, goal.id)
        feature = await feature_service.create_feature(
            s, FeatureCreate(name="Estimate climb power", product_id=climb.id,
                             capability_ids=[strava.id, physics.id]),
        )
        ids = {g.title: f"{'OG' if g.goal_type == GoalType.org else 'PG'}-{g.seq:02d}"
               for g in (og_climb, og_saddle, pg_climb, pg_saddle)}

    text = await server._dispatch("feature_why", {"feature": "Estimate climb power"})
    _conventions(text)
    lines = text.splitlines()
    assert lines[0] == (
        "2 capabilit(ies) and 4 goal(s) above Estimate climb power (can-i-climb): "
        "2 of can-i-climb, 2 of other products."
    )
    own = lines.index("Goals of can-i-climb (2):")
    other = next(
        i for i, line in enumerate(lines) if line.startswith("Goals of other products (2)")
    )
    assert own < other
    mine = " ".join(lines[own + 1:other])
    assert ids["Trust the estimate"] in mine and "motivates Strava import" in mine
    assert ids["Riders know before they ride"] in mine
    assert f"parent of {ids['Trust the estimate']}" in mine
    theirs = lines[other + 1:-2]
    saddle_og = next(line for line in theirs if ids["Every bike ready"] in line)
    # Met first as a parent, it still says what it motivates directly.
    assert "saddlebag" in saddle_og
    assert f"motivates Physics model; parent of {ids['Plan the ride']}" in saddle_og
    saddle_pg = next(line for line in theirs if ids["Plan the ride"] in line)
    assert "saddlebag" in saddle_pg and "motivates Strava import" in saddle_pg
    assert text.endswith(f"Open: /features?feature={feature.id}")


async def _why_world(db):
    """Ours on an org goal, someone else's product with no goal, and a product
    whose goal links to none of its feature's capabilities."""
    async with db() as s:
        auth = await capability_service.create_capability(s, CapabilityCreate(name="User auth"))
        og_ours = Goal(goal_type=GoalType.org, title="Plan work well")
        og_makers = Goal(goal_type=GoalType.org, title="Grow the maker community")
        s.add_all([og_ours, og_makers])
        await s.flush()
        ours = Product(name="Taskmaster", slug="taskmaster", goal_id=og_ours.id)
        makers = Product(name="Makers", slug="makers", goal_id=og_makers.id)
        strava = Product(name="Strava", slug="strava", external=True)
        s.add_all([ours, makers, strava])
        await s.commit()
        await capability_service.add_motivation(s, auth.id, og_ours.id)
        for name, product in (("Find athletes", strava), ("Manage your profile", makers)):
            await feature_service.create_feature(
                s, FeatureCreate(name=name, product_id=product.id, capability_ids=[auth.id])
            )
        return f"OG-{og_ours.seq:02d}", f"OG-{og_makers.seq:02d}"


async def test_feature_why_of_someone_elses_product_claims_no_goal(api):
    """Our goals motivate the capability a Strava feature shares; they are not
    why Strava built it, and metis records no goal of Strava's."""
    og_ours, _ = await _why_world(api[1])
    text = await server._dispatch("feature_why", {"feature": "Find athletes"})
    _conventions(text)
    lines = text.splitlines()
    assert lines[0] == (
        "1 capabilit(ies) and 1 goal(s) above Find athletes (strava): "
        "0 of strava, 1 of other products."
    )
    assert "strava is someone else's product: metis doesn't record its goals." in lines
    assert "Goals of strava" not in text
    theirs = next(line for line in lines if og_ours in line)
    assert "taskmaster" in theirs and "motivates User auth" in theirs


async def test_feature_why_names_the_products_goal_when_it_links_to_none(api):
    og_ours, og_makers = await _why_world(api[1])
    text = await server._dispatch("feature_why", {"feature": "Manage your profile"})
    _conventions(text)
    assert (
        f"No goal of makers motivates these capabilities; its goal is "
        f"{og_makers} Grow the maker community."
    ) in text.splitlines()
    assert "has no goal of its own" not in text
    assert og_ours in text and "taskmaster" in text


async def test_journeys_list_and_analysis(api):
    w = await _world(*api)
    listing = await server._dispatch("journeys", {})
    _conventions(listing)
    assert listing.startswith("1 journey(s).") and str(w["journey"].id) in listing

    text = await server._dispatch("journeys", {"journey": str(w["journey"].id)})
    _conventions(text)
    assert text.startswith(
        "2 step(s) in Plan a climb: 1 buildable, 0 known_covered, 1 missing, 0 unknown; "
        "1 live today."
    )
    assert "Check wind needs, not ours: Weather forecast" in text
    # The exact name works like the id; anything else lists nothing and says so.
    assert await server._dispatch("journeys", {"journey": "Plan a climb"}) == text
    missing = await server._dispatch("journeys", {"journey": "onboarding"})
    _conventions(missing)
    assert missing.startswith("0 journeys are named 'onboarding'. Matching is exact")


async def test_capability_takes_a_name_as_check_idea_does(api):
    """check_idea resolves "User-Authentication" to its slug; so does capability."""
    await _world(*api)
    by_slug = await server._dispatch("capability", {"slug": "strava-import"})
    for value in ("Strava import", "Strava-Import", "STRAVA IMPORT"):
        assert await server._dispatch("capability", {"slug": value}) == by_slug

async def test_ready_features_filters_by_product(api):
    w = await _world(*api)
    text = await server._dispatch("ready_features", {})
    _conventions(text)
    assert text.startswith("1 feature(s) ready to start — pending, every dependency done.")
    assert "Show ride history" in text and "can-i-climb" in text
    # Rival is external: its features are never our work, so nothing of ours
    # is there to start, and it says so rather than "every feature of ours".
    rival = await server._dispatch("ready_features", {"product": "rival"})
    assert rival.splitlines() == [
        "0 feature(s) ready to start in rival: it is external, and its features are never "
        "our work. Call ready_features without a product, or with one of ours.",
        f"Open: /products?product={w['rival'].id}",
    ]

    blocked = render.ready_features([], [], None, pending=2)
    assert "Nothing is ready: 2 pending feature(s), each waits on one not done." in blocked
    assert "check_idea" in blocked and blocked.endswith("Open: /home")
    assert (await server._dispatch("ready_features", {"product": "nope"})).startswith("0 products")


async def test_recheck_by_exact_name_or_id(api):
    """Estimate climb power is needed by Show ride history: it breaks. Rival
    map shares a capability but its product is external, so not elsewhere."""
    w = await _world(*api)
    text = await server._dispatch("recheck", {"feature": "Estimate climb power"})
    _conventions(text)
    assert text.startswith(
        "1 feature(s) break and 0 to retest in the same product if Estimate climb power "
        "changes; 0 broad capabilit(ies), 0 other product(s) with the same capabilities."
    )
    lines = text.splitlines()
    for heading in ("Breaks (1)", "Retest (same product) (0)", "Broad (many features) (0)",
                    "Same capability elsewhere (info only) (0)"):
        assert any(line.startswith(heading) for line in lines), heading
    row = next(line for line in lines if "Show ride history" in line)
    assert "direct" in row and "can-i-climb" in row and str(w["forecast"].id) in row
    assert "—" not in text

    by_id = await server._dispatch("recheck", {"feature": str(w["forecast"].id)})
    assert by_id.startswith("0 feature(s) break and 1 to retest")
    assert "Estimate climb power  score 0.5  shares: Strava import" in by_id
    assert by_id.endswith(f"Open: /features?feature={w['forecast'].id}")

    near = await server._dispatch("recheck", {"feature": "Estimate climb"})
    assert near.startswith("0 features are named 'Estimate climb'.")
    assert near.endswith("Open: /features")


@pytest.mark.parametrize(
    "name,args,hostile",
    [
        ("feature_why", {"feature": "../../admin/llm"}, "../../admin/llm"),
        ("journeys", {"journey": "x/../../users"}, "x/../../users"),
        ("capability", {"slug": "../users"}, "../users"),
        ("capability_supply", {"capability": "../../admin"}, "../../admin"),
    ],
)
async def test_names_never_reach_a_request_path(api, monkeypatch, name, args, hostile):
    """Ids and slugs go into request paths, so only something shaped like one
    gets there. A name is matched in memory or travels as a query parameter —
    a hostile one finds nothing, and walks nowhere."""
    await _world(*api)
    paths = []
    real = server.client._send

    async def spy(method, path, **kwargs):
        paths.append(path)
        return await real(method, path, **kwargs)

    monkeypatch.setattr(server.client, "_send", spy)
    await server.call_tool(name, args)
    assert paths and not any(hostile in p or ".." in p for p in paths), paths


async def test_an_api_refusal_is_rendered_not_raised(api, monkeypatch):
    """A refusal from the API comes back as text the agent can quote. (An
    unknown subject is not one: that is an answer, below.)"""
    import httpx

    def gone(request):
        return httpx.Response(404, json={"detail": "Product not found"})

    monkeypatch.setattr(
        server.client, "_http", httpx.AsyncClient(transport=httpx.MockTransport(gone))
    )
    result = await server.call_tool("products", {})
    assert result.isError
    assert result.content[0].text.splitlines() == [
        "Refused (404): Product not found",
        "Open: /products",
    ]


async def test_capability_says_how_many_come_only_through_a_sub_capability(api):
    """The count rolls up the submap; the features linked only below it are
    named as such, so the number isn't read as direct links."""
    app, db = api
    w = await _world(app, db)
    async with db() as s:
        from sqlalchemy import select

        from app.models import Capability

        strava = await s.scalar(select(Capability).where(Capability.slug == "strava-import"))
        child = await capability_service.create_capability(
            s, CapabilityCreate(name="Strava webhooks", parent_id=strava.id)
        )
        await feature_service.create_feature(
            s, FeatureCreate(name="Push new rides", product_id=w["climb"].id, capability_ids=[child.id])
        )
    text = await server._dispatch("capability", {"slug": "strava-import"})
    assert text.startswith(
        "3 feature(s) of ours (1 only through its sub-capabilities), at any status, "
        "realize strava-import across 1 product(s); maturity ga."
    )
    # The inventory and the supply count the same features, labelled the same way.
    text = await server._dispatch("capability_inventory", {"q": "strava"})
    assert "3 feature(s) (1 only through its sub-capabilities)" in row(text, "strava-import")
    assert "1 feature(s)  " in row(text, "strava-webhooks") and "only through" not in row(text, "strava-webhooks")
    text = await server._dispatch("capability_supply", {"capability": "strava-import"})
    assert (
        "Build side — 3 feature(s) of ours (1 only through its sub-capabilities) realize it, "
        "any status (1 done):"
    ) in text.splitlines()


async def test_an_empty_answer_says_what_would_fill_it(api):
    """No doubled blank line where an empty table sat, and a next step."""
    def envelope_of(slug):
        return {"answer": [], "subject": {"slug": slug}, "href": "/h", "as_of": "now"}

    said = {
        render.capability_supply(envelope_of("user-authentication")): "No technology is recorded as satisfying it.",
        render.tech_exposure(envelope_of("x")): "Nothing recorded reaches its end of life",
        render.stack_recommend(envelope_of("taskmaster007")): "taskmaster007 has no stack slot to bind.",
        render.tech_search({"rows": [], "total": 0}, "fastapi"): "No technology is recorded yet, so nothing can match.",
        render.tech_search({"rows": [], "total": 0}, "fastapi", 3): "None of the 3 recorded technolog(ies) match.",
        render.journeys([]): "No journey is recorded yet.",
        render.tech_blast_radius(envelope_of("pg")): "0 product(s) use pg",
    }
    for text, line in said.items():
        assert "\n\n\n" not in text, text
        assert line in text, text
        assert text.splitlines()[-1].startswith("Open: /"), text

    # A missing ops burden is said, not a bare "?".
    offer = {"tech": "networkx", "fit": "native", "stance": None, "cost": {}, "bound_in": []}
    supply = render.capability_supply({**envelope_of("graph"), "answer": [offer]})
    assert "ops not recorded" in supply and "ops ?" not in supply
    offer["cost"] = {"ops_burden": 0}
    supply = render.capability_supply({**envelope_of("graph"), "answer": [offer]})
    assert "ops 0" in supply and "ops not recorded" not in supply

    # tech_search reads the whole catalog's size only when a filter matched nothing.
    await _world(*api)
    empty = await server._dispatch("tech_search", {"q": "fastapi"})
    assert "No technology is recorded yet" in empty


async def test_an_unknown_product_or_id_is_an_answer_in_every_tool(api):
    """The tools that take a product answer an unknown one as product_score
    does; the tools that take an id answer an unknown id as an unknown name."""
    w = await _world(*api)

    async def answer(name, args):
        result = await server.call_tool(name, args)
        assert isinstance(result, list), result.content[0].text
        return result[0].text

    absent = await answer("product_score", {"product": "no-such-product"})
    assert absent.startswith("0 products have id or slug 'no-such-product'.")
    for tool in ("tech_exposure", "stack_redundancy", "stack_recommend"):
        assert await answer(tool, {"product": "no-such-product"}) == absent
    # A product's id works where its slug does.
    by_id = await answer("stack_redundancy", {"product": str(w["climb"].id)})
    assert by_id == await answer("stack_redundancy", {"product": "can-i-climb"})
    assert by_id.startswith("0 capabilit(ies) answered more than once in can-i-climb.")

    zero = "00000000-0000-0000-0000-000000000000"
    for tool in ("feature_why", "recheck"):
        text = await answer(tool, {"feature": zero})
        assert text.splitlines() == [
            f"0 features are named {zero!r}. Matching is exact: pass an id or the exact name.",
            "Open: /features",
        ]
    journeys = await answer("journeys", {"journey": zero})
    assert journeys.startswith(f"0 journeys are named {zero!r}. Matching is exact")


@pytest.mark.parametrize(
    "name,args,said,href",
    [
        ("propose_binding", {"slot": "db", "tech": "qdrant", "rationale": "x"},
         "Not a slot id: 'db'. Slot ids are UUIDs; the metis://stacks/{product} "
         "resource lists a product's slots.", "/stacks"),
        ("tech_blast_radius", {"tech": "Qdrant"},
         "Not a technology slug: 'Qdrant'. Slugs are lowercase letters, digits and "
         "dashes; tech_search lists them.", "/tech"),
        ("capability", {"slug": "!!!"},
         "Not a capability slug or name: '!!!'. capability_inventory lists them.",
         "/capabilities"),
    ],
)
async def test_a_bad_input_is_an_error_that_says_what_to_pass(api, name, args, said, href):
    result = await server.call_tool(name, args)
    assert result.isError
    assert result.content[0].text.splitlines() == [said, f"Open: {href}"]


async def test_an_unreachable_backend_says_which_and_the_setting(api, monkeypatch):
    """Not httpx's "All connection attempts failed": which service, and the
    setting that points at it."""
    import httpx

    def refuse(request):
        raise httpx.ConnectError("All connection attempts failed", request=request)

    client = server.client
    monkeypatch.setattr(client, "_http", httpx.AsyncClient(transport=httpx.MockTransport(refuse)))
    result = await server.call_tool("products", {})
    assert result.isError
    first, last = result.content[0].text.splitlines()
    assert first.startswith("Cannot reach the metis API at http://test")
    assert "MCP_API_BASE_URL" in first
    assert last == "Open: /products"

    # Auth on: the token request comes first, so a refused secret is named
    # as that, not as a raw 401 from some URL.
    def keycloak(request):
        return httpx.Response(401, json={"error": "unauthorized_client",
                                         "error_description": "Invalid client credentials"})

    monkeypatch.setattr(client, "_http", httpx.AsyncClient(transport=httpx.MockTransport(keycloak)))
    monkeypatch.setattr(client, "_settings", Settings(auth_enabled=True))
    monkeypatch.setattr(client, "_token", None)
    result = await server.call_tool("products", {})
    assert result.isError
    text = result.content[0].text
    assert text.startswith(
        "Keycloak refused to sign this server in as metis-mcp "
        "(401: Invalid client credentials). Check METIS_MCP_CLIENT_SECRET"
    )


def test_the_client_secret_is_read_under_the_name_env_example_gives(tmp_path, monkeypatch):
    """.env.example and compose say METIS_MCP_CLIENT_SECRET; a stdio server
    reading the root .env took only KEYCLOAK_MCP_CLIENT_SECRET (D46b). The
    documented name wins, and the old one still works on its own."""
    for name in ("METIS_MCP_CLIENT_SECRET", "KEYCLOAK_MCP_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("METIS_MCP_CLIENT_SECRET=from-dot-env\n")
    assert Settings().keycloak_mcp_client_secret == "from-dot-env"
    (tmp_path / ".env").write_text("")
    monkeypatch.setenv("KEYCLOAK_MCP_CLIENT_SECRET", "old-name")
    assert Settings().keycloak_mcp_client_secret == "old-name"
    monkeypatch.setenv("METIS_MCP_CLIENT_SECRET", "new-name")
    assert Settings().keycloak_mcp_client_secret == "new-name"


async def test_an_auth_off_server_against_an_auth_on_api_says_so(api, monkeypatch):
    import httpx

    def wants_token(request):
        return httpx.Response(401, json={"detail": "Not authenticated"})

    monkeypatch.setattr(
        server.client, "_http", httpx.AsyncClient(transport=httpx.MockTransport(wants_token))
    )
    result = await server.call_tool("products", {})
    assert result.isError
    assert result.content[0].text.splitlines() == [
        "Refused (401): Not authenticated",
        "This server sent no token (its AUTH_ENABLED is false), and the API wants one: "
        "set AUTH_ENABLED=true for this server as well.",
        "Open: /products",
    ]


@pytest.mark.parametrize("path", ["/api/stacks/metis/recommend", "/api/capabilities/coverage"])
def test_every_post_the_mcp_server_makes_is_a_read(path):
    """check_idea and the unknown-capability lookup POST the coverage
    endpoint. The boundary exempts that exact path; nothing else."""
    authorize("POST", Principal(sub="m", username="m", roles=["viewer"], surface=Surface.mcp), path)


@pytest.mark.parametrize(
    "method,path",
    [("POST", "/api/capabilities"), ("POST", "/api/features"), ("PATCH", "/api/products/abc")],
)
def test_real_writes_from_mcp_are_still_refused(method, path):
    with pytest.raises(HTTPException) as err:
        authorize(
            method,
            Principal(sub="m", username="m", roles=["admin"], surface=Surface.mcp),
            path,
        )
    assert err.value.status_code == 403
    assert err.value.detail["error"] == "human_action_required"


async def test_an_exact_miss_offers_near_names_and_never_picks_one(api):
    """Products, features and journeys still match exactly. A miss offers
    near names by the rule check_idea's candidates follow, each leading with
    what the next call takes, and a case-only difference is always one."""
    w = await _world(*api)
    climb = w["climb"]

    product = await server._dispatch("product_score", {"product": "Can I Climb"})
    assert product.splitlines() == [
        "0 products have id or slug 'Can I Climb'. Call `products` for ids and slugs.",
        'Near names, unconfirmed: can-i-climb "Can I Climb"',
        "Open: /products",
    ]
    for tool in ("tech_exposure", "stack_redundancy", "stack_recommend", "ready_features"):
        assert await server._dispatch(tool, {"product": "Can I Climb"}) == product
    assert 'rival "Rival"' in await server._dispatch("product_score", {"product": "RIVAL"})

    for tool in ("feature_why", "recheck"):
        feature = await server._dispatch(tool, {"feature": "estimate climb power"})
        lines = feature.splitlines()
        assert lines[0] == (
            "0 features are named 'estimate climb power'. Matching is exact: pass an id or the exact name."
        )
        assert lines[1].startswith("Near names, unconfirmed: ")
        offered = lines[1].removeprefix("Near names, unconfirmed: ").split(", ")
        # Nearest first, the case-only one; each with its id and product.
        assert offered[0].endswith('"Estimate climb power" (can-i-climb)')
        assert lines[-1] == "Open: /features"
    picked = await server._dispatch("recheck", {"feature": offered[0].split()[0]})
    assert not picked.startswith("0 features")

    journey = await server._dispatch("journeys", {"journey": "plan a CLIMB"})
    assert journey.splitlines()[1] == f'Near names, unconfirmed: {w["journey"].id} "Plan a climb"'

    # Nothing near, or an id: the miss alone, as before.
    assert await server._dispatch("product_score", {"product": "zzzz"}) == (
        "0 products have id or slug 'zzzz'. Call `products` for ids and slugs.\nOpen: /products"
    )
    assert "Near names" not in await server._dispatch("journeys", {"journey": "qqqq xxxx"})


async def test_the_list_reads_offer_near_names_on_request(api):
    """`near` on the product, feature and journey lists: three at most,
    nearest first, case ignored, nothing for a name far from every row, and a
    name longer than any name refused."""
    app, _ = api
    await _world(*api)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        async def names(path, near):
            res = await http.get(path, params={"near": near})
            assert res.status_code == 200, res.text
            return [r["name"] for r in res.json()]

        assert await names("/api/products", "can i climb") == ["Can I Climb"]
        near = await names("/api/features", "RIVAL")
        assert len(near) == 3 and all(n.startswith("Rival") for n in near)
        assert await names("/api/journeys", "PLAN A CLIMB") == ["Plan a climb"]
        assert await names("/api/products", "zzzz") == []
        res = await http.get("/api/products", params={"near": "n" * (MAX_NAME + 1)})
        assert res.status_code == 422 and f"at most {MAX_NAME} characters" in res.json()["detail"]
        # Without it, the whole list as before.
        assert len((await http.get("/api/products")).json()) == 2


async def test_check_idea_takes_the_api_s_bounds_and_says_which_one(api):
    """check_idea's schema carries the coverage body's limits, so an agent is
    told before any request; the one across all features only the API checks,
    and its 422 still reads as a sentence with the limit in it. A capability
    asked for by a name too long to be one is refused the same way, since its
    miss would post that name to coverage."""
    await _world(*api)

    async def call(name, arguments):
        result = await server.call_tool(name, arguments)
        return result.content[0].text.splitlines() if not isinstance(result, list) else None

    one = {"name": "f", "capabilities": ["Strava import"]}
    assert await call("check_idea", {"features": [one] * MAX_IDEA_FEATURES}) is None
    refused = await call("check_idea", {"features": [one] * (MAX_IDEA_FEATURES + 1)})
    assert refused == [
        f"Arguments refused at features: at most {MAX_IDEA_FEATURES} items, got {MAX_IDEA_FEATURES + 1}.",
        "Open: /home",
    ]
    names = [f"name {i}" for i in range(MAX_IDEA_NAMES + 1)]
    refused = await call(
        "check_idea",
        {"features": [{"name": "a", "capabilities": names[:150]}, {"name": "b", "capabilities": names[150:]}]},
    )
    assert refused == [
        f"Refused (422): body: Value error, at most {MAX_IDEA_NAMES} capability names per "
        f"request across all features, got {MAX_IDEA_NAMES + 1}",
        "Open: /home",
    ]
    long = "c" * (MAX_CAPABILITY_NAME + 1)
    for tool, arg in (("capability", "slug"), ("capability_supply", "capability")):
        refused = await call(tool, {arg: long})
        assert refused[0] == (
            f"Arguments refused at {arg}: at most {MAX_CAPABILITY_NAME} characters, "
            f"got {MAX_CAPABILITY_NAME + 1}."
        )


async def test_a_product_with_more_features_than_a_body_may_carry_is_still_scored(api):
    """The bounds are on the body a caller sends; a stored product's features
    are scored in-process, whatever their number."""
    app, db = api
    async with db() as s:
        cap = await capability_service.create_capability(s, CapabilityCreate(name="Search"))
        big = Product(name="Big rival", slug="big-rival", external=True)
        s.add(big)
        await s.commit()
        for i in range(MAX_IDEA_FEATURES + 1):
            await feature_service.create_feature(
                s, FeatureCreate(name=f"Rival feature {i}", product_id=big.id, capability_ids=[cap.id])
            )
    text = await server._dispatch("product_score", {"product": "big-rival"})
    assert text.startswith(f"0/{MAX_IDEA_FEATURES + 1} feature(s) of big-rival buildable")


async def test_sdk_and_resource_errors_end_with_an_open_line(api):
    """The SDK's own checks and a resource read refuse in the tools' shape:
    one plain sentence, then the screen, never a raw exception."""
    import mcp.types as types

    await _world(*api)
    handler = server.server.request_handlers[types.CallToolRequest]

    async def call(name, arguments):
        request = types.CallToolRequest(
            method="tools/call", params=types.CallToolRequestParams(name=name, arguments=arguments)
        )
        return (await handler(request)).root

    empty = await call("check_idea", {"features": []})
    assert empty.isError
    assert empty.content[0].text.splitlines() == [
        "Arguments refused at features: [] should be non-empty.",
        "Open: /home",
    ]
    unknown = await call("no_such_tool", {})
    assert unknown.isError
    first, last = unknown.content[0].text.splitlines()
    assert first.startswith("No tool named 'no_such_tool'. The tools are: tech_search, ")
    assert last == "Open: /home"

    read = server.server.request_handlers[types.ReadResourceRequest]
    for uri, said, href in [
        ("metis://tech/postgresql", "Refused (404): Technology not found", "/tech"),
        ("metis://tech/Bad", "Not a slug: 'Bad'. Slugs are lowercase letters, digits and dashes.", "/tech"),
        ("metis://stacks/nobody", "No product 'nobody' in metis. The products tool lists their slugs.", "/stacks"),
    ]:
        with pytest.raises(ValueError) as err:
            await read(types.ReadResourceRequest(
                method="resources/read", params=types.ReadResourceRequestParams(uri=AnyUrl(uri))
            ))
        assert str(err.value).splitlines() == [said, f"Open: {href}"]

    prompt = server.server.request_handlers[types.GetPromptRequest]
    with pytest.raises(ValueError) as err:
        await prompt(types.GetPromptRequest(
            method="prompts/get", params=types.GetPromptRequestParams(name="nope")
        ))
    assert str(err.value).splitlines() == [
        "No prompt named 'nope'. The prompts are: check_this_dependency, choose_a_stack, "
        "explain_the_ontology.",
        "Open: /home",
    ]


async def test_an_unknown_capability_technology_or_slot_is_an_answer(api):
    """capability_supply finds a capability the way `capability` does, so an
    unknown one is the same answer with the same near names, not a refusal;
    an unknown technology or slot reads the same way."""
    await _world(*api)

    async def answer(name, args):
        """An answer is plain content; an error would be a CallToolResult."""
        result = await server.call_tool(name, args)
        assert isinstance(result, list), result
        return result[0].text

    for value in ("strava", "x?y=1", "a/b"):
        supply = await answer("capability_supply", {"capability": value})
        assert supply == await answer("capability", {"slug": value})
        assert supply.startswith("0 capabilities have slug")
    supply = await answer("capability_supply", {"capability": "Strava import"})
    assert supply.startswith("0 offer(s) for strava-import.")
    for tool in ("tech_blast_radius", "tech_encounters"):
        assert (await answer(tool, {"tech": "postgresql"})).splitlines() == [
            "0 technologies have slug 'postgresql'. Matching is exact; tech_search lists them.",
            "Open: /tech",
        ]
    slot = "16ce952e-44cd-4317-9176-b3c7de518d9f"
    proposed = await answer("propose_binding", {"slot": slot, "tech": "qdrant", "rationale": "x"})
    assert proposed.startswith(f"0 slots have id '{slot}'.")


async def test_ours_lists_say_any_status(api):
    """A product named beside `ours` may have only unfinished work on it, so
    the list says "any status" rather than implying each one has it."""
    await _world(*api)
    text = await server._dispatch(
        "check_idea", {"features": [{"name": "Plan", "capabilities": ["Strava import"]}]}
    )
    assert any(
        "strava-import (ga; our products on it, any status: can-i-climb)" in line
        for line in text.splitlines()
    )
    inventory = await server._dispatch("capability_inventory", {"q": "strava"})
    assert "our products, any status: can-i-climb" in inventory


@pytest.mark.parametrize(
    "body",
    [{"detail": "Not Found"}, {"error": "Unable to find matching target resource method"}, "<html>"],
)
async def test_a_reachable_but_wrong_base_url_names_the_setting(api, monkeypatch, body):
    """Another service, or the right one under /api twice, answers 404 the
    way no metis route does: that is a setting, not a missing subject."""
    import httpx

    def wrong(request):
        if isinstance(body, str):
            return httpx.Response(404, text=body)
        return httpx.Response(404, json=body)

    monkeypatch.setattr(
        server.client, "_http", httpx.AsyncClient(transport=httpx.MockTransport(wrong))
    )
    result = await server.call_tool("products", {})
    assert result.isError
    first, last = result.content[0].text.splitlines()
    assert first.startswith("http://test answered 404 to /api/products the way no metis route does")
    assert "MCP_API_BASE_URL" in first
    assert last == "Open: /products"
