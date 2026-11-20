"""The agent turn, run in the background.

`start_turn` saves the user's message and an orchestrator reply marked
`running`, then starts `run_turn` as a task and returns at once: the turn no
longer depends on the browser that asked. The orchestrator plans one to three
tasks, the specialists run them at the same time (each with its own database
session and its own reply row under the orchestrator's), and when there was
more than one, the orchestrator writes the combined answer.

Every reply is saved as it is written, so a client polling the thread sees
text and steps arrive, can leave and come back, and a reload loses nothing.
Tools that change data never run here: each call becomes a ChatProposal the
user approves (app.agents.proposals). A restart marks unfinished replies
`interrupted` (`mark_interrupted`, called at startup).
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import anyio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents import orchestrator
from app.agents import proposals as proposal_service
from app.agents.prompts import AGENT_PROMPTS, PROPOSALS_NOTE, SYNTHESIS_PROMPT
from app.agents.tools import WRITE_TOOLS, ToolContext, ToolError, execute_tool, tools_for
from app.llm.base import NoProviderError
from app.llm.types import StreamError, TextDelta, ToolCallEvent
from app.models import ChatMessage, ChatProposal, ChatThread

MAX_ITERATIONS = 6
HISTORY_LIMIT = 30
#: How often a running reply is written back while text streams in.
SAVE_EVERY_SECONDS = 0.75

log = logging.getLogger("metis.chat")


def changes_data(tool_name: str) -> bool:
    return tool_name in WRITE_TOOLS


def summarize_result(output: str) -> str:
    """One line a person can read: what a tool call found, made, or why it failed."""
    try:
        data = json.loads(output)
    except (TypeError, ValueError):
        # Text (a coverage answer): its first line is the headline.
        return (output or "").split("\n", 1)[0][:200]
    if isinstance(data, dict) and "error" in data:
        return f"error: {data['error']}"[:200]
    if isinstance(data, list):
        return f"{len(data)} result{'' if len(data) == 1 else 's'}"
    if isinstance(data, dict):
        label = next((data[k] for k in ("display_id", "name", "title") if data.get(k)), None)
        if label is not None:
            extra = data.get("title") if data.get("display_id") else None
            return f"{label}: {extra}"[:200] if extra else str(label)[:200]
        parts = []
        for key, value in data.items():
            if key == "id" or key.endswith("_id"):
                continue  # a UUID: nobody reads it, and the card names things instead
            label = key.replace("_", " ")
            if isinstance(value, list):
                parts.append(f"{label}: {len(value)}")
            elif isinstance(value, (int, float, bool)) or (isinstance(value, str) and len(value) <= 40):
                parts.append(f"{label}: {value}")
        return " · ".join(parts)[:200]
    return str(data)[:200]


async def _history(session: AsyncSession, thread_id: uuid.UUID) -> list[dict[str, Any]]:
    """The conversation as the model sees it. A delegated reply is skipped when
    its orchestrator wrote a combined answer, which already covers it."""
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.thread_id == thread_id, ChatMessage.status != "running")
        .order_by(ChatMessage.seq.desc())
        .limit(HISTORY_LIMIT)
    )
    rows = list((await session.scalars(stmt)).all())[::-1]
    combined = {r.id for r in rows if r.parent_id is None and r.role == "agent" and r.content}
    messages: list[dict[str, Any]] = []
    for row in rows:
        if row.parent_id in combined or not row.content:
            continue
        messages.append({"role": "assistant" if row.role == "agent" else "user", "content": row.content})
    return messages


async def _save(sessionmaker, message_id: uuid.UUID, **values) -> None:
    """Write fields of one reply in a short session of its own, so a reply's
    progress never shares a transaction with the tools it runs."""
    with anyio.CancelScope(shield=True):
        async with sessionmaker() as session:
            await session.execute(update(ChatMessage).where(ChatMessage.id == message_id).values(**values))
            await session.commit()


async def start_turn(sessionmaker, graph, registry, thread_id: uuid.UUID, content: str, runs: set) -> dict:
    async with sessionmaker() as session:
        if await session.get(ChatThread, thread_id) is None:
            raise LookupError("Thread not found")
        user = ChatMessage(thread_id=thread_id, role="user", content=content)
        session.add(user)
        await session.flush()
        run = ChatMessage(thread_id=thread_id, role="agent", agent_name="orchestrator", status="running")
        session.add(run)
        await session.commit()
        ids = {"user_message_id": str(user.id), "run_id": str(run.id)}
    task = asyncio.create_task(run_turn(sessionmaker, graph, registry, thread_id, run.id, content))
    runs.add(task)  # a strong reference, or the loop may collect it mid-run
    task.add_done_callback(runs.discard)
    return ids


async def run_turn(sessionmaker, graph, registry, thread_id: uuid.UUID, run_id: uuid.UUID, content: str) -> None:
    try:
        async with sessionmaker() as session:
            history = await _history(session, thread_id)
            # The user's message is already saved; the specialist adds it itself.
            if history and history[-1] == {"role": "user", "content": content}:
                history.pop()
            tasks = await orchestrator.plan(content, registry, session)
            children = []
            for agent, task in tasks:
                child = ChatMessage(
                    thread_id=thread_id, role="agent", agent_name=agent, status="running",
                    parent_id=run_id, task=task if len(tasks) > 1 else None,
                )
                session.add(child)
                children.append(child)
            await session.commit()
            plan = [(c.id, c.agent_name, c.task) for c in children]

        results = await asyncio.gather(
            *(run_specialist(sessionmaker, graph, registry, cid, agent, history, content, task)
              for cid, agent, task in plan),
            return_exceptions=True,
        )
        replies = [
            (agent, task, r) for (_, agent, task), r in zip(plan, results) if isinstance(r, str) and r
        ]
        if len(plan) > 1 and replies:
            await _synthesize(sessionmaker, registry, run_id, content, replies)
        failed = all(isinstance(r, BaseException) for r in results)
        await _save(sessionmaker, run_id, status="failed" if failed else "done")
    except asyncio.CancelledError:
        await _save(sessionmaker, run_id, status="interrupted")
        raise
    except Exception:
        log.exception("Turn %s in thread %s failed", run_id, thread_id)
        await _save(sessionmaker, run_id, status="failed", content="This request stopped because of an internal error.")


async def _synthesize(sessionmaker, registry, run_id, content, replies) -> None:
    parts = "\n\n".join(
        f"## {agent}\nTask: {task}\n\n{text}" for agent, task, text in replies
    )
    async with sessionmaker() as session:
        try:
            provider, model = await registry.resolve_for_agent(session, "orchestrator")
        except NoProviderError:
            return
    text, last = "", time.monotonic()
    messages = [{"role": "user", "content": f"The request:\n{content}\n\nWhat the specialists found:\n\n{parts}"}]
    async for event in provider.stream(model, SYNTHESIS_PROMPT, messages):
        if isinstance(event, TextDelta):
            text += event.text
            if time.monotonic() - last > SAVE_EVERY_SECONDS:
                await _save(sessionmaker, run_id, content=text)
                last = time.monotonic()
        elif isinstance(event, StreamError):
            log.warning("Synthesis for %s failed: %s", run_id, event.message)
            break
    await _save(sessionmaker, run_id, content=text.strip())


async def run_specialist(
    sessionmaker, graph, registry, message_id: uuid.UUID, agent_name: str,
    history: list[dict[str, Any]], content: str, task: str | None,
) -> str:
    """One specialist's tool loop. Returns its final text. Read tools run;
    write tools become proposals."""
    text_parts: list[str] = []
    partial = ""
    viz_blocks: list[dict[str, Any]] = []
    steps: list[dict[str, Any]] = []
    last_save = time.monotonic()

    def text() -> str:
        return "\n\n".join(p for p in [*text_parts, partial] if p).strip()

    async def save(**extra) -> None:
        nonlocal last_save
        await _save(sessionmaker, message_id, content=text(), viz=list(viz_blocks), tool_calls=list(steps) or None, **extra)
        last_save = time.monotonic()

    messages = list(history)
    if task:
        messages.append({"role": "user", "content": f"{content}\n\nYour part of this request, from the orchestrator: {task}"})
    else:
        messages.append({"role": "user", "content": content})

    session = sessionmaker()
    try:
        try:
            provider, model = await registry.resolve_for_agent(session, agent_name)
        except NoProviderError as e:
            text_parts.append(str(e))
            await save(status="failed")
            return ""
        system = AGENT_PROMPTS[agent_name] + PROPOSALS_NOTE
        tools = tools_for(agent_name)
        ctx = ToolContext(session=session, graph=graph)
        hit_limit = True
        for _ in range(MAX_ITERATIONS):
            partial = ""
            calls: list[ToolCallEvent] = []
            failed = False
            async for event in provider.stream(model, system, messages, tools):
                if isinstance(event, TextDelta):
                    partial += event.text
                    if time.monotonic() - last_save > SAVE_EVERY_SECONDS:
                        await save()
                elif isinstance(event, ToolCallEvent):
                    calls.append(event)
                elif isinstance(event, StreamError):
                    text_parts.append(f"LLM call failed: {event.message}")
                    failed = True
            said = partial
            if partial:
                text_parts.append(partial)
            partial = ""
            if failed or not calls:
                hit_limit = False
                break
            messages.append({
                "role": "assistant",
                "content": said,
                "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in calls],
            })
            for call in calls:
                step = {"name": call.name, "arguments": call.arguments, "changes": changes_data(call.name), "status": "started"}
                steps.append(step)
                await save()
                if step["changes"]:
                    output, proposed = await _propose(sessionmaker, message_id, call)
                    if proposed:
                        step.update(status="proposed", summary="waiting for your approval")
                    else:
                        step.update(status="failed", summary=summarize_result(output))
                else:
                    output, status, new_viz = await _read(ctx, agent_name, call, message_id)
                    viz_blocks.extend(new_viz)
                    step.update(status=status, summary=summarize_result(output))
                messages.append({"role": "tool", "tool_call_id": call.id, "name": call.name, "content": output})
            await save()
        if hit_limit:
            text_parts.append("Stopped after reaching the tool-iteration limit.")
        await save(status="done")
        return text()
    except asyncio.CancelledError:
        await save(status="interrupted")
        raise
    except Exception:
        log.exception("Agent %s failed on reply %s", agent_name, message_id)
        text_parts.append("This agent stopped because of an internal error.")
        await save(status="failed")
        raise
    finally:
        with anyio.CancelScope(shield=True):
            await session.close()


async def _read(ctx: ToolContext, agent_name: str, call: ToolCallEvent, message_id) -> tuple[str, str, list]:
    try:
        result = await execute_tool(agent_name, call.name, call.arguments, ctx)
        return result.result, "finished", list(result.viz)
    except (ToolError, TypeError) as e:
        return json.dumps({"error": str(e)}), "failed", []
    except Exception:
        # Unexpected: the detail stays in the server log. What is saved and
        # shown in the thread (and fed to the model) is generic.
        log.exception("Tool %s failed on reply %s", call.name, message_id)
        return json.dumps({"error": "internal error while running this tool"}), "failed", []
    finally:
        # Reads only: end the transaction so it isn't held open across model calls.
        await ctx.session.rollback()


async def _propose(sessionmaker, message_id, call: ToolCallEvent) -> tuple[str, bool]:
    """Save a write as a proposal, its references pinned to the rows the
    person will see on the card and approval will act on. A reference that
    fits no row, or several, is refused back to the agent instead."""
    with anyio.CancelScope(shield=True):
        async with sessionmaker() as session:
            try:
                arguments = await proposal_service.pin(session, message_id, call.name, call.arguments)
            except ToolError as e:
                return json.dumps({"error": f"Not proposed: {e}"}), False
            except Exception:
                # Model output is untrusted: whatever it was, this one change
                # is refused and the rest of the reply goes on.
                log.exception("Pinning %s on reply %s failed", call.name, message_id)
                return json.dumps({"error": "Not proposed: its references couldn't be read."}), False
            session.add(ChatProposal(message_id=message_id, tool_name=call.name, arguments=arguments))
            await session.commit()
    return json.dumps({
        "proposed": True,
        "status": "awaiting the user's approval",
        "note": "Not applied yet. The user approves or rejects it after you finish.",
    }), True


async def mark_interrupted(sessionmaker) -> None:
    """At startup: no run survives a restart, so none may look like it is running."""
    async with sessionmaker() as session:
        await session.execute(
            update(ChatMessage).where(ChatMessage.status == "running").values(status="interrupted")
        )
        await session.execute(
            update(ChatProposal)
            .where(ChatProposal.status == "applying")
            .values(status="failed", result="The server restarted while applying this; check whether it took effect.")
        )
        await session.commit()
