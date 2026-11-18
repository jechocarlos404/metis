"""Applying the changes agents propose.

An agent's write-tool calls are saved as ChatProposal rows and nothing else
happens until a person decides. Approving claims the row atomically
(pending -> applying), so a double click or two tabs can't apply it twice,
then runs the tool exactly once in a session of its own. Within one reply,
proposals are decided in the order the agent made them: later ones may refer
by name to things earlier ones create.
"""

import json
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.tools import ToolContext, ToolError, execute_tool

log = logging.getLogger("metis.chat")


class ProposalConflict(Exception):
    """The proposal can't be decided now (already decided, or out of order)."""


async def _earlier_pending(session: AsyncSession, proposal) -> bool:
    from app.models import ChatProposal

    stmt = select(ChatProposal.id).where(
        ChatProposal.message_id == proposal.message_id,
        ChatProposal.seq < proposal.seq,
        ChatProposal.status.in_(("pending", "applying")),
    )
    return (await session.scalar(stmt.limit(1))) is not None


async def _claim(session: AsyncSession, proposal_id: uuid.UUID, to: str):
    from app.models import ChatProposal

    proposal = await session.get(ChatProposal, proposal_id)
    if proposal is None:
        raise LookupError("Proposal not found")
    if proposal.status != "pending":
        raise ProposalConflict(f"This change is already {proposal.status}.")
    if await _earlier_pending(session, proposal):
        raise ProposalConflict("Decide the earlier changes from this reply first.")
    claimed = await session.execute(
        update(ChatProposal)
        .where(ChatProposal.id == proposal_id, ChatProposal.status == "pending")
        .values(status=to, decided_at=datetime.now(UTC))
        .returning(ChatProposal.id)
    )
    if claimed.scalar_one_or_none() is None:
        raise ProposalConflict("Someone else just decided this change.")
    await session.commit()
    await session.refresh(proposal)
    return proposal


async def reject(sessionmaker, proposal_id: uuid.UUID):
    async with sessionmaker() as session:
        return await _claim(session, proposal_id, "rejected")


async def approve(sessionmaker, graph, proposal_id: uuid.UUID):
    from app.models import ChatMessage, ChatProposal

    async with sessionmaker() as session:
        proposal = await _claim(session, proposal_id, "applying")
        message = await session.get(ChatMessage, proposal.message_id)
        agent = message.agent_name

    async with sessionmaker() as session:
        try:
            result = await execute_tool(agent, proposal.tool_name, dict(proposal.arguments), ToolContext(session=session, graph=graph))
            status, outcome = "applied", result.result
        except (ToolError, TypeError) as e:
            await session.rollback()
            status, outcome = "failed", json.dumps({"error": str(e)})
        except Exception:
            log.exception("Applying proposal %s failed", proposal_id)
            await session.rollback()
            status, outcome = "failed", json.dumps({"error": "internal error while applying this change"})

    from app.agents.runner import summarize_result

    async with sessionmaker() as session:
        await session.execute(
            update(ChatProposal).where(ChatProposal.id == proposal_id).values(status=status, result=summarize_result(outcome))
        )
        await session.commit()
        return await session.get(ChatProposal, proposal_id)


async def approve_all(sessionmaker, graph, message_id: uuid.UUID):
    """Every pending change of one reply, in order, stopping at the first failure."""
    from app.models import ChatProposal

    decided = []
    async with sessionmaker() as session:
        ids = (await session.scalars(
            select(ChatProposal.id)
            .where(ChatProposal.message_id == message_id, ChatProposal.status == "pending")
            .order_by(ChatProposal.seq)
        )).all()
    for pid in ids:
        proposal = await approve(sessionmaker, graph, pid)
        decided.append(proposal)
        if proposal.status != "applied":
            break
    return decided
