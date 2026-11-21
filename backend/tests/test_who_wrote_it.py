"""A write records who made it: the signed-in person, never what the client
claims. With auth off (local dev) the client's value or its default stands.
The access log reaches stderr, since nothing else configures logging."""

import logging

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.auth import Principal, current_user
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models.enums import Surface

EDITOR = Principal(
    sub="u-1", username="editor", email="editor@metis.local", roles=["editor"],
    surface=Surface.desktop,
)


@pytest_asyncio.fixture
async def app(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    return app


async def _writes(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        product = (await http.post("/api/products", json={"name": "Notes"})).json()
        prd = await http.post(
            f"/api/products/{product['id']}/decompositions",
            json={"document": {"summary": "s"}, "created_by": "someone-else"},
        )
        strategy = await http.post(
            f"/api/products/{product['id']}/strategies", json={"created_by": "someone-else"}
        )
        default = await http.post(f"/api/products/{product['id']}/strategies", json={})
    assert prd.status_code == strategy.status_code == default.status_code == 201
    return prd.json()["created_by"], strategy.json()["created_by"], default.json()["created_by"]


async def test_with_auth_on_the_signed_in_person_is_recorded_over_the_claim(app):
    app.dependency_overrides[current_user] = lambda: EDITOR
    assert await _writes(app) == ("editor", "editor", "editor")


async def test_a_token_without_a_username_records_the_email(app):
    app.dependency_overrides[current_user] = lambda: Principal(
        sub="u-2", username="", email="e@metis.local", roles=["editor"], surface=Surface.desktop
    )
    assert await _writes(app) == ("e@metis.local",) * 3


async def test_with_auth_off_the_claim_and_default_stand(app):
    assert await _writes(app) == ("someone-else", "someone-else", "user")


def test_the_access_log_is_emitted_at_info():
    create_app()
    log = logging.getLogger("metis.access")
    assert log.isEnabledFor(logging.INFO)
    assert any(isinstance(h, logging.StreamHandler) for h in logging.getLogger("metis").handlers)


async def _approved_chat_writes(app, db):
    """A PRD and a delivery strategy written by approving a Chat proposal
    through the route: who each is recorded as made by."""
    from sqlalchemy import select

    from app.models import ChatMessage, ChatProposal, ChatThread, DeliveryStrategy, Product, ProductDecomposition
    from app.services.graph_service import FeatureGraph

    app.state.sessionmaker, app.state.graph = db, FeatureGraph(sessionmaker=None)
    async with db() as session:
        product = Product(name="Notes", slug="notes")
        thread = ChatThread(title="t")
        session.add_all([product, thread])
        await session.flush()
        ids = []
        for agent, tool, arguments in (
            ("spec_decomposer", "create_prd_draft", {"product": str(product.id), "document": {"summary": "s"}}),
            ("strategist", "create_delivery_strategy", {"product": str(product.id), "phases": []}),
        ):
            message = ChatMessage(thread_id=thread.id, role="agent", agent_name=agent)
            session.add(message)
            await session.flush()
            proposal = ChatProposal(message_id=message.id, tool_name=tool, arguments=arguments)
            session.add(proposal)
            await session.flush()
            ids.append(proposal.id)
        await session.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        for proposal_id in ids:
            res = await http.post(f"/api/chat/proposals/{proposal_id}/approve")
            assert res.status_code == 200 and res.json()["status"] == "applied", res.text
    async with db() as session:
        return (
            await session.scalar(select(ProductDecomposition.created_by)),
            await session.scalar(select(DeliveryStrategy.created_by)),
        )


async def test_a_chat_write_records_the_person_who_approved_it(app, db):
    """A Chat change is applied when a person approves it, so with auth on
    that person is recorded, by the same rule as the REST writes; the agent
    that proposed it was recorded instead."""
    app.dependency_overrides[current_user] = lambda: EDITOR
    assert await _approved_chat_writes(app, db) == ("editor", "editor")


async def test_with_auth_off_a_chat_write_keeps_the_agent_name(app, db):
    assert await _approved_chat_writes(app, db) == ("spec_decomposer", "strategist")
