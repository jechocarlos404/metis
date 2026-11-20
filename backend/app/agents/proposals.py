"""Applying the changes agents propose.

An agent's write-tool calls are saved as ChatProposal rows and nothing else
happens until a person decides. Approving claims the row atomically
(pending -> applying), so a double click or two tabs can't apply it twice,
then runs the tool exactly once in a session of its own. Within one reply,
proposals are decided in the order the agent made them: later ones may refer
by name to things earlier ones create.

What a person approves is what runs. When a proposal is made, every
reference in it (goal, capability, feature, product, ticket, PRD pins) is
pinned to one row's ID: by ID, code, exact name, a thing an earlier change
in the same reply creates, or a name only one row contains. A name that
fits several rows is refused, and the agent is told so. The card names
each pinned row; approval acts on the same IDs, never on names. A thing an
earlier change creates is held as {"proposal": id, "name": name} until that
change applies, which hands its new ID on; if it never applies, the later
change fails with a plain reason instead of guessing.
"""

import copy
import json
import logging
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.tools import ToolContext, ToolError, _resolve_capabilities, execute_tool
from app.models import Capability, ChatProposal, Epic, Feature, Goal, Product, Story, Ticket
from app.services.slugs import slugify

log = logging.getLogger("metis.chat")


# ---- pinning references ----

def _goal_name(g: Goal) -> str:
    return f"{'OG' if g.goal_type == 'org' else 'PG'}-{g.seq:02d} {g.title}"


#: (model, code prefix, name column, noun, label for the card)
_GOAL = (Goal, "(?:PG|OG)", Goal.title, "goal", _goal_name)
_CAPABILITY = (Capability, "CAP", Capability.name, "capability", lambda c: c.name)
_FEATURE = (Feature, "FTR", Feature.name, "feature", lambda f: f.name)
_TICKET = (Ticket, "TKT", Ticket.title, "ticket", lambda t: f"TKT-{t.seq:04d} {t.title}")
_PRODUCT = (Product, "SPEC", Product.name, "product", lambda p: p.name)
_REFS = {
    "goal": _GOAL, "capability": _CAPABILITY, "parent": _CAPABILITY, "product": _PRODUCT,
    "feature": _FEATURE, "src": _FEATURE, "dst": _FEATURE, "ticket": _TICKET,
}
#: Write tools that make a named thing a later proposal may refer to.
_CREATES = {"create_capability": Capability, "create_feature": Feature, "create_product_spec": Product}


def _is_new(value) -> bool:
    """A reference to what an earlier proposal in the reply creates."""
    return isinstance(value, dict) and set(value) == {"proposal", "name"}


async def _walk(tool_name: str, arguments: dict, visit) -> dict:
    """A copy of `arguments` with each reference slot replaced by
    `await visit(kind, value, exact_only)`. Model output is untrusted: a slot
    of the wrong shape is skipped here and left for the tool to refuse."""
    out = copy.deepcopy(arguments)
    for key, value in arguments.items():
        if key in _REFS:
            out[key] = await visit(_REFS[key], value, False)
        elif key == "capabilities" and tool_name in ("create_feature", "update_feature") and isinstance(value, list):
            # REALIZES links are exact (tools._resolve_capabilities): no near names.
            out[key] = [await visit(_CAPABILITY, v, True) for v in value]
    document = out.get("document") if tool_name == "create_prd_draft" else None
    epics = document.get("epics") if isinstance(document, dict) else None
    for epic in epics if isinstance(epics, list) else []:
        if not isinstance(epic, dict):
            continue
        if epic.get("capability") not in (None, ""):
            epic["capability"] = await visit(_CAPABILITY, epic["capability"], False)
        stories = epic.get("stories")
        for story in stories if isinstance(stories, list) else []:
            if isinstance(story, dict) and story.get("feature") not in (None, ""):
                story["feature"] = await visit(_FEATURE, story["feature"], False)
    return out


async def _find(session, kind, ref: str, earlier: list[dict], exact_only: bool):
    """One row's ID (as a string) for `ref`, or a reference to an earlier
    proposal's creation. Raises ToolError when nothing, or more than one row,
    fits."""
    model, prefix, column, noun, label = kind
    ref = ref.strip()
    try:
        found = await session.get(model, uuid.UUID(ref))
        if found is None:
            raise ToolError(f"No {noun} has the ID `{ref}`.")
        return str(found.id)
    except ValueError:
        pass
    code = re.fullmatch(rf"{prefix}-?0*(\d+)", ref, re.IGNORECASE)
    if code and not exact_only:
        found = await session.scalar(select(model).where(model.seq == int(code.group(1))))
        if found is not None:
            return str(found.id)
    for e in earlier:
        if e["model"] is model and e["name"].strip().lower() == ref.lower():
            return {"proposal": e["id"], "name": e["name"]}
    same = func.lower(column) == ref.lower()
    if hasattr(model, "slug"):
        same = or_(same, model.slug == slugify(ref))
    rows = (await session.scalars(select(model).where(same).limit(4))).all()
    if not rows and not exact_only:
        escaped = ref.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = (await session.scalars(select(model).where(column.ilike(f"%{escaped}%", escape="\\")).limit(4))).all()
    if len(rows) == 1:
        return str(rows[0].id)
    if not rows and exact_only:
        await _resolve_capabilities(session, [ref])  # raises, naming the near names
    if rows:
        names = ", ".join(f"`{label(r)}`" for r in rows[:3])
        raise ToolError(f"`{ref}` fits more than one {noun} ({names}). Name exactly one.")
    raise ToolError(f"No {noun} is named `{ref}`.")


async def pin(session: AsyncSession, message_id: uuid.UUID, tool_name: str, arguments: dict) -> dict:
    """`arguments` with every reference pinned to one row (or to what an
    earlier proposal in this reply creates). Raises ToolError, with a reason
    the agent can act on, when a reference fits no row or several."""
    if not isinstance(arguments, dict):
        raise ToolError("Arguments must be an object.")
    earlier = [
        {"id": str(p.id), "model": _CREATES[p.tool_name], "name": p.arguments["name"]}
        for p in await session.scalars(
            select(ChatProposal).where(ChatProposal.message_id == message_id).order_by(ChatProposal.seq)
        )
        if p.tool_name in _CREATES and isinstance(p.arguments.get("name"), str)
    ]

    async def visit(kind, value, exact_only):
        if value is None or value == "":
            return value
        if not isinstance(value, str):
            raise ToolError(f"A {kind[3]} reference must be a name or an ID, not {json.dumps(value)[:60]}.")
        return await _find(session, kind, value, earlier, exact_only)

    return await _walk(tool_name, arguments, visit)


async def _ready(session, proposal) -> dict:
    """The arguments approval runs: pinned IDs checked to still exist, and
    names in proposals saved before pinning existed pinned the same strict
    way. A creation an earlier change never handed on fails plainly."""

    async def visit(kind, value, exact_only):
        if _is_new(value):
            raise ToolError(
                f"It uses the {kind[3]} {value['name']}, which an earlier change in this reply "
                "was to create, and that change wasn't applied."
            )
        if not isinstance(value, str) or value == "":
            return value
        return await _find(session, kind, value, [], exact_only)

    return await _walk(proposal.tool_name, dict(proposal.arguments), visit)


async def _hand_on(session, proposal, outcome: str) -> None:
    """A creation applied: give its new ID to the later pending changes in
    the same reply that refer to it."""
    if proposal.tool_name not in _CREATES:
        return
    try:
        new_id = json.loads(outcome).get("id")
    except (TypeError, ValueError, AttributeError):
        return
    if not new_id:
        return
    mine = str(proposal.id)

    def swap(value):
        if _is_new(value) and value["proposal"] == mine:
            return new_id
        if isinstance(value, list):
            return [swap(v) for v in value]
        if isinstance(value, dict):
            return {k: swap(v) for k, v in value.items()}
        return value

    later = await session.scalars(
        select(ChatProposal).where(
            ChatProposal.message_id == proposal.message_id,
            ChatProposal.seq > proposal.seq,
            ChatProposal.status == "pending",
        )
    )
    for p in later:
        swapped = swap(p.arguments)
        if swapped != p.arguments:
            p.arguments = swapped  # a new object, so the JSONB change is saved


# ---- naming what a proposal touches, for the card ----

async def _title(session, model, ref):
    try:
        found = await session.get(model, uuid.UUID(str(ref)))
    except ValueError:
        return ref
    return found.title if found is not None else ref


async def named_arguments(session: AsyncSession, tool_name: str, arguments: dict, positions: dict | None = None) -> dict:
    """`arguments` with each reference replaced by the name of the row it is
    pinned to: the row approval will act on. `positions` numbers the reply's
    proposals, to say which change makes a thing that doesn't exist yet."""

    async def visit(kind, value, exact_only):
        if _is_new(value):
            at = (positions or {}).get(value["proposal"])
            return f"{value['name']} (new, from change {at})" if at else str(value["name"])
        if not isinstance(value, str) or value == "":
            return value
        try:
            found = await session.get(kind[0], uuid.UUID(await _find(session, kind, value, [], exact_only)))
        except (ToolError, ValueError, TypeError):
            return value
        return kind[4](found) if found is not None else value

    named = await _walk(tool_name, arguments, visit)
    for key, model in (("epic_id", Epic), ("story_id", Story)):
        if isinstance(named.get(key), str) and named[key]:
            named[key] = await _title(session, model, named[key])
    return named


async def name_proposals(session: AsyncSession, proposals) -> None:
    """Fill `named_arguments` on each ProposalRead of one reply."""
    positions = {str(p.id): i for i, p in enumerate(proposals, 1)}
    for p in proposals:
        p.named_arguments = await named_arguments(session, p.tool_name, p.arguments, positions)


# ---- deciding ----

class ProposalConflict(Exception):
    """The proposal can't be decided now (already decided, or out of order)."""


async def _earlier_pending(session: AsyncSession, proposal) -> bool:
    stmt = select(ChatProposal.id).where(
        ChatProposal.message_id == proposal.message_id,
        ChatProposal.seq < proposal.seq,
        ChatProposal.status.in_(("pending", "applying")),
    )
    return (await session.scalar(stmt.limit(1))) is not None


async def _claim(session: AsyncSession, proposal_id: uuid.UUID, to: str):
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
    from app.models import ChatMessage

    async with sessionmaker() as session:
        proposal = await _claim(session, proposal_id, "applying")
        message = await session.get(ChatMessage, proposal.message_id)
        agent = message.agent_name

    async with sessionmaker() as session:
        try:
            arguments = await _ready(session, proposal)
            result = await execute_tool(agent, proposal.tool_name, arguments, ToolContext(session=session, graph=graph))
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
        # One commit: a later change can't be claimed between "applied" and
        # receiving the ID this one created.
        if status == "applied":
            await _hand_on(session, proposal, outcome)
        await session.execute(
            update(ChatProposal).where(ChatProposal.id == proposal_id).values(status=status, result=summarize_result(outcome))
        )
        await session.commit()
        return await session.get(ChatProposal, proposal_id)


async def approve_all(sessionmaker, graph, message_id: uuid.UUID):
    """Every pending change of one reply, in order, stopping at the first failure."""
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
