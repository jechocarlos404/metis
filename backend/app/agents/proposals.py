"""Applying the changes agents propose.

An agent's write-tool calls are saved as ChatProposal rows and nothing else
happens until a person decides. Approving claims the row atomically
(pending -> applying), so a double click or two tabs can't apply it twice,
then runs the tool exactly once in a session of its own. Within one reply,
proposals are decided in the order the agent made them: later ones may refer
by name to things earlier ones create.
"""

import copy
import json
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.tools import ToolContext, ToolError, _resolve, _resolve_capabilities, execute_tool
from app.models import Capability, Epic, Feature, Goal, Product, Story, Ticket

log = logging.getLogger("metis.chat")


# ---- naming what a proposal touches ----
#
# A proposal's arguments are what the agent passed: often a UUID or a code
# where a person needs a name. The card shows the same arguments with each
# reference replaced by the name of what it resolves to, found the way the
# tool will find it when approved. `arguments` themselves never change: they
# are what approval runs.

def _goal_name(g: Goal) -> str:
    return f"{'OG' if g.goal_type == 'org' else 'PG'}-{g.seq:02d} {g.title}"


_GOAL = (Goal, "(?:PG|OG)", Goal.title, _goal_name)
_CAPABILITY = (Capability, "CAP", Capability.name, lambda c: c.name)
_FEATURE = (Feature, "FTR", Feature.name, lambda f: f.name)
_TICKET = (Ticket, "TKT", Ticket.title, lambda t: f"TKT-{t.seq:04d} {t.title}")
#: Products are found by SPEC-xxx, except where the tool itself uses PRD.
_PRODUCT = {
    tool: (Product, "PRD" if tool in ("create_feature", "update_feature") else "SPEC", Product.name, lambda p: p.name)
    for tool in ("create_product_spec", "create_prd_draft", "create_ticket", "create_feature",
                 "update_feature", "create_delivery_strategy")
}
_REFS = {
    "goal": _GOAL, "capability": _CAPABILITY, "parent": _CAPABILITY,
    "feature": _FEATURE, "src": _FEATURE, "dst": _FEATURE, "ticket": _TICKET,
}
#: Write tools that make a named thing a later proposal may refer to.
_CREATES = ("create_capability", "create_feature", "create_product_spec")


async def _name(session, ref, how, created: set[str]):
    """The name `ref` resolves to, or `ref` itself when nothing matches yet
    (or an earlier change in the same reply makes it)."""
    if not isinstance(ref, str) or not ref.strip() or ref.strip().lower() in created:
        return ref
    model, prefix, column, label = how
    try:
        return label(await _resolve(session, model, ref, prefix, column))
    except ToolError:
        return ref


async def _capability_name(session, ref, created: set[str]):
    """Exact, like the REALIZES links create_feature and update_feature make."""
    if not isinstance(ref, str) or ref.strip().lower() in created:
        return ref
    try:
        (found,) = await _resolve_capabilities(session, [ref])
    except ToolError:
        return ref
    return (await session.get(Capability, found)).name


async def _title(session, model, ref):
    try:
        found = await session.get(model, uuid.UUID(str(ref)))
    except ValueError:
        return ref
    return found.title if found is not None else ref


async def named_arguments(session: AsyncSession, tool_name: str, arguments: dict, created: set[str]) -> dict:
    named = copy.deepcopy(arguments)
    for key, value in arguments.items():
        if key == "product" and tool_name in _PRODUCT:
            named[key] = await _name(session, value, _PRODUCT[tool_name], created)
        elif key in _REFS:
            named[key] = await _name(session, value, _REFS[key], created)
        elif key == "capabilities" and isinstance(value, list):
            named[key] = [await _capability_name(session, v, created) for v in value]
        elif key in ("epic_id", "story_id") and value:
            named[key] = await _title(session, Epic if key == "epic_id" else Story, value)
    if tool_name == "create_prd_draft" and isinstance(named.get("document"), dict):
        for epic in named["document"].get("epics") or []:
            if epic.get("capability"):
                epic["capability"] = await _name(session, epic["capability"], _CAPABILITY, created)
            for story in epic.get("stories") or []:
                if story.get("feature"):
                    story["feature"] = await _name(session, story["feature"], _FEATURE, created)
    return named


async def name_proposals(session: AsyncSession, proposals) -> None:
    """Fill `named_arguments` on each ProposalRead of one reply, in order."""
    created: set[str] = set()
    for p in proposals:
        p.named_arguments = await named_arguments(session, p.tool_name, p.arguments, created)
        if p.tool_name in _CREATES and isinstance(p.arguments.get("name"), str):
            created.add(p.arguments["name"].strip().lower())


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
