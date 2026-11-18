"""The agent turn loop.

Yields (event_name, payload) tuples that the chat router serializes as SSE:
    routing      {agent}
    message_start{agent}
    text_delta   {text}
    tool_call    {name, status: started|finished|failed, summary?}
    viz_block    {type, data}
    message_end  {message}
    error        {message}

The agent reply is persisted whichever way the turn ends, so a client
disconnect mid-stream never loses the message. That persist — and the
session's own teardown — run inside `anyio.CancelScope(shield=True)`: a
disconnect cancels this generator, and under a cancelled scope every await
raises at once, including the connection pool's graceful close.
"""

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

import anyio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents import orchestrator
from app.agents.prompts import AGENT_PROMPTS
from app.agents.tools import ToolContext, ToolError, execute_tool, tools_for
from app.llm.base import NoProviderError
from app.llm.types import StreamDone, StreamError, TextDelta, ToolCallEvent
from app.models import ChatMessage, ChatThread

MAX_ITERATIONS = 6
HISTORY_LIMIT = 30

log = logging.getLogger("metis.chat")


async def _history(session: AsyncSession, thread_id: uuid.UUID) -> list[dict[str, Any]]:
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.thread_id == thread_id)
        .order_by(ChatMessage.created_at.desc(), ChatMessage.seq.desc())
        .limit(HISTORY_LIMIT)
    )
    rows = list((await session.scalars(stmt)).all())[::-1]
    messages: list[dict[str, Any]] = []
    for row in rows:
        role = "assistant" if row.role == "agent" else "user"
        if row.content:
            messages.append({"role": role, "content": row.content})
    return messages


# Tools that change data. Everything else only reads.
_WRITE_PREFIXES = ("create_", "update_", "link_", "motivate_", "set_")


def changes_data(tool_name: str) -> bool:
    return tool_name.startswith(_WRITE_PREFIXES)


def summarize_result(output: str) -> str:
    """One line a person can read: what a tool call found, made, or why it failed."""
    try:
        data = json.loads(output)
    except (TypeError, ValueError):
        return (output or "")[:200]
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
            label = key.replace("_", " ")
            if isinstance(value, list):
                parts.append(f"{label}: {len(value)}")
            elif isinstance(value, (int, float, bool)) or (isinstance(value, str) and len(value) <= 40):
                parts.append(f"{label}: {value}")
        return " · ".join(parts)[:200]
    return str(data)[:200]


def _serialize_message(message: ChatMessage) -> dict[str, Any]:
    return {
        "id": str(message.id),
        "thread_id": str(message.thread_id),
        "role": message.role,
        "agent_name": message.agent_name,
        "content": message.content,
        "viz": message.viz,
        "tool_calls": message.tool_calls,
        "created_at": message.created_at.isoformat(),
    }


async def run_turn(
    sessionmaker: async_sessionmaker[AsyncSession],
    graph,
    registry,
    thread_id: uuid.UUID,
    content: str,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    session = sessionmaker()
    try:
        thread = await session.get(ChatThread, thread_id)
        if thread is None:
            yield ("error", {"message": "Thread not found"})
            return

        user_message = ChatMessage(thread_id=thread_id, role="user", content=content)
        session.add(user_message)
        await session.commit()

        history = await _history(session, thread_id)

        agent_name = await orchestrator.route(content, registry, session)
        yield ("routing", {"agent": agent_name})
        yield ("message_start", {"agent": agent_name})

        text_parts: list[str] = []
        # The iteration being streamed right now. Held out here so a disconnect
        # mid-stream keeps the deltas the client already saw.
        partial = ""
        viz_blocks: list[dict[str, Any]] = []
        tool_trace: list[dict[str, Any]] = []

        def _content() -> str:
            return "\n\n".join(part for part in [*text_parts, partial] if part).strip()

        async def persist() -> ChatMessage:
            message = ChatMessage(
                thread_id=thread_id,
                role="agent",
                agent_name=agent_name,
                content=_content(),
                viz=viz_blocks,
                tool_calls=tool_trace or None,
            )
            session.add(message)
            await session.commit()
            await session.refresh(message)
            return message

        try:
            try:
                provider, model = await registry.resolve_for_agent(session, agent_name)
            except NoProviderError as e:
                notice = str(e)
                text_parts.append(notice)
                yield ("text_delta", {"text": notice})
                provider = None

            system = AGENT_PROMPTS[agent_name]
            tools = tools_for(agent_name)
            messages = history  # already ends with the just-persisted user message
            ctx = ToolContext(session=session, graph=graph)

            hit_iteration_limit = provider is not None
            for _iteration in range(MAX_ITERATIONS if provider else 0):
                partial = ""
                tool_calls: list[ToolCallEvent] = []
                failed = False

                async for event in provider.stream(model, system, messages, tools):
                    if isinstance(event, TextDelta):
                        partial += event.text
                        yield ("text_delta", {"text": event.text})
                    elif isinstance(event, ToolCallEvent):
                        tool_calls.append(event)
                    elif isinstance(event, StreamError):
                        message = f"LLM call failed: {event.message}"
                        text_parts.append(message)
                        yield ("error", {"message": message})
                        failed = True
                    elif isinstance(event, StreamDone):
                        pass

                iteration_text = partial  # kept for the assistant turn below
                if partial:
                    text_parts.append(partial)
                partial = ""  # folded above; _content() must not count it twice
                if failed or not tool_calls:
                    hit_iteration_limit = False
                    break

                messages.append(
                    {
                        "role": "assistant",
                        "content": iteration_text,
                        "tool_calls": [
                            {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                            for tc in tool_calls
                        ],
                    }
                )
                for tc in tool_calls:
                    writes = changes_data(tc.name)
                    yield (
                        "tool_call",
                        {"name": tc.name, "status": "started", "arguments": tc.arguments, "changes": writes},
                    )
                    try:
                        result = await execute_tool(agent_name, tc.name, tc.arguments, ctx)
                        output = result.result
                        status = "finished"
                        for viz in result.viz:
                            viz_blocks.append(viz)
                            yield ("viz_block", viz)
                    except (ToolError, TypeError) as e:
                        await session.rollback()
                        output = json.dumps({"error": str(e)})
                        status = "failed"
                    except Exception as e:
                        await session.rollback()
                        output = json.dumps({"error": f"{type(e).__name__}: {e}"})
                        status = "failed"
                    step = {
                        "name": tc.name,
                        "arguments": tc.arguments,
                        "status": status,
                        "changes": writes,
                        "summary": summarize_result(output),
                    }
                    tool_trace.append(step)
                    yield ("tool_call", step)
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "name": tc.name,
                            "content": output,
                        }
                    )
            if hit_iteration_limit:
                note = "Stopped after reaching the tool-iteration limit."
                text_parts.append(note)
                yield ("text_delta", {"text": "\n" + note})

        except BaseException:
            # Cancelled by a client disconnect, or the turn blew up. Keep what
            # was generated, but never let a failure here mask the exception on
            # its way out — nothing downstream is waiting for the reply now.
            with anyio.CancelScope(shield=True):
                try:
                    # Nothing reached the client yet: no reply to keep, and a
                    # blank row would render as an empty bubble.
                    if _content() or viz_blocks or tool_trace:
                        await persist()
                except Exception:
                    log.exception("Could not persist the agent reply for %s", thread_id)
            raise

        agent_message = await persist()
        yield ("message_end", {"message": _serialize_message(agent_message)})
    finally:
        # Under a cancelled scope the pool's graceful close is cancelled too,
        # which terminates the connection instead of returning it.
        with anyio.CancelScope(shield=True):
            await session.close()
