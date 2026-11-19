"""MCP rendering and the two stop conditions.

The renderers are pure functions over an envelope, so they test without a
server — and they are exactly where the surfaces would drift apart, because
this is the only place the shared rows get turned into something else.
"""

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, authorize
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.mcp import render, server
from app.mcp.client import MetisClient
from app.mcp.server import PROMPTS, RESOURCE_TEMPLATES, RESOURCES, TOOLS, _hard_stop
from app.models import CapabilityMaturity, Goal, GoalType, Product, WorkStatus
from app.models.enums import Surface
from app.schemas.capability import CapabilityCreate
from app.schemas.envelope import Question
from app.schemas.feature import EdgeCreate, FeatureCreate
from app.schemas.journey import JourneyCreate, JourneyStepIn
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services import journeys as journey_service
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
    assert len(TOOLS) == 16
    assert len(RESOURCES) + len(RESOURCE_TEMPLATES) == 4
    assert len(PROMPTS) == 3


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
        "href": "/stacks?slot=api::Auth"}})
    assert "human_action_required" in text
    assert text.endswith("Open: /stacks?slot=api::Auth")


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


@pytest.mark.asyncio
async def test_sse_requires_a_bearer_token():
    """stdio inherits the launcher's identity; a listening socket inherits
    nothing, and this process holds an API token."""
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from app.mcp.auth import BearerGate

    app = Starlette(
        routes=[Route("/sse", lambda r: PlainTextResponse("ok"))],
        middleware=[Middleware(BearerGate, token="s3cret")],
    )
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/sse")).status_code == 401
        assert (await c.get("/sse", headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await c.get("/sse", headers={"Authorization": "Bearer s3cret"})).status_code == 200


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
        def cap(name, maturity=CapabilityMaturity.planned):
            return capability_service.create_capability(
                s, CapabilityCreate(name=name, maturity=maturity)
            )

        strava = await cap("Strava import", CapabilityMaturity.ga)
        elevation = await cap("Elevation data", CapabilityMaturity.beta)
        physics = await cap("Physics model", CapabilityMaturity.alpha)
        weather = await cap("Weather forecast")
        await cap("Route planner")
        climb = Product(name="Can I Climb", slug="can-i-climb")
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


async def test_inventory_is_most_reused_first_and_filters_in_order(api):
    await _world(*api)
    text = await server._dispatch("capability_inventory", {})
    _conventions(text)
    assert text.startswith(
        "5 capabilit(ies): 3 ours with features, 1 ours with no feature yet, "
        "1 known only from external products"
    )
    rows = [line.split()[0] for line in text.splitlines()[2:7]]
    assert rows[-1] == "weather-forecast"
    assert "external only — not ours" in text

    text = await server._dispatch("capability_inventory", {"q": "data"})
    assert text.startswith("1 of 5 capabilit(ies) match 'data'")
    text = await server._dispatch("capability_inventory", {"q": "teleport"})
    assert text.startswith("0 of 5") and "That is an answer" in text


async def test_check_idea_never_counts_a_near_name(api):
    """Ours, external only, and no match with candidates — and the candidate
    stays a candidate."""
    await _world(*api)
    text = await server._dispatch(
        "check_idea",
        {"features": [{"name": "Climb planner",
                       "capabilities": ["Strava import", "Weather forecast", "Elevaton data"]}]},
    )
    _conventions(text)
    assert text.startswith(
        "1/3 distinct capabilit(ies) are ours, 1 of them proven (beta or ga); 2 not ours."
    )
    lines = text.splitlines()
    assert any(line.strip().startswith("ours") and "strava-import (ga" in line for line in lines)
    assert any(line.strip().startswith("external only") and "rival" in line for line in lines)
    miss = next(i for i, line in enumerate(lines) if line.strip() == "no match       Elevaton data")
    assert "near names, unconfirmed: elevation-data" in lines[miss + 1]
    assert "Not ours (2): Weather forecast, Elevaton data" in text


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
    assert "Missing a capability — fully described, needs one we don't have (1): Rival weather" in text
    assert "Lower bound" in text
    assert text.endswith(f"Open: /products?product={w['rival'].id}")
    by_id = await server._dispatch("product_score", {"product": str(w["climb"].id)})
    assert by_id.startswith("2/2 feature(s) of can-i-climb buildable")
    assert (await server._dispatch("product_score", {"product": "Rival"})).startswith(
        "0 products have id or slug 'Rival'"
    )


async def test_capability_says_who_why_and_how_far(api):
    await _world(*api)
    text = await server._dispatch("capability", {"slug": "strava-import"})
    _conventions(text)
    assert text.startswith(
        "2 feature(s) of ours realize strava-import across 1 product(s); maturity ga."
    )
    assert "Rollup: 2 total — 1 pending, 0 in_progress, 1 done." in text
    assert "Our products: can-i-climb" in text
    assert "PG-" in text and "Riders trust the estimate" in text
    assert "Rival weather" not in text  # external features are not ours

    weather = await server._dispatch("capability", {"slug": "weather-forecast"})
    assert "Known only from external products" in weather
    assert "External products that have it: rival" in weather
    assert "No goal motivates it directly" in weather

    missing = await server._dispatch("capability", {"slug": "strava"})
    assert missing.startswith("0 capabilities have slug 'strava'. Matching is exact.")
    assert "Near names, unconfirmed: strava-import" in missing


async def test_feature_why_walks_up_to_the_goal(api):
    w = await _world(*api)
    text = await server._dispatch("feature_why", {"feature": str(w["forecast"].id)})
    _conventions(text)
    assert text.startswith("1 capabilit(ies) and 1 goal(s) above Show ride history.")
    assert "REALIZES" in text and "MOTIVATES" in text and "PG-" in text


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


async def test_ready_features_filters_by_product(api):
    await _world(*api)
    text = await server._dispatch("ready_features", {})
    _conventions(text)
    assert text.startswith("1 feature(s) ready to start — pending, every dependency done.")
    assert "Show ride history" in text and "can-i-climb" in text
    rival = await server._dispatch("ready_features", {"product": "rival"})
    assert rival.startswith("0 feature(s) ready to start in rival") and "Nothing is ready" in rival
    assert (await server._dispatch("ready_features", {"product": "nope"})).startswith("0 products")


@pytest.mark.parametrize(
    "name,args",
    [
        ("feature_why", {"feature": "../../admin/llm"}),
        ("journeys", {"journey": "x/../../users"}),
        ("capability", {"slug": "../users"}),
    ],
)
async def test_inventory_tools_take_ids_only_in_the_shape_of_ids(name, args):
    """Ids go into request paths, so the same guard as slugs applies — and it
    fires before any request is made."""
    with pytest.raises(ValueError):
        await server._dispatch(name, args)


async def test_an_api_refusal_is_rendered_not_raised(api):
    """A 404 from the API comes back as text the agent can quote."""
    await _world(*api)
    result = await server.call_tool(
        "feature_why", {"feature": "16ce952e-44cd-4317-9176-b3c7de518d9f"}
    )
    text = result[0].text if isinstance(result, list) else result.content[0].text
    assert text.startswith("Refused (404)")


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
