"""MCP rendering and the two stop conditions.

The renderers are pure functions over an envelope, so they test without a
server — and they are exactly where the surfaces would drift apart, because
this is the only place the shared rows get turned into something else.
"""

import pytest

from app.mcp import render
from app.mcp.server import PROMPTS, RESOURCE_TEMPLATES, RESOURCES, TOOLS, _hard_stop
from app.schemas.envelope import Question


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


def test_tool_names_are_the_question_keys():
    """One vocabulary across desktop, API and MCP, or the transcripts stop
    lining up."""
    names = {t.name for t in TOOLS}
    assert {str(q) for q in Question} <= names
    assert names - {str(q) for q in Question} == {"tech_search", "propose_binding"}
    assert len(TOOLS) == 8
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
