"""The agent turn loop.

Yields (event_name, payload) tuples that the chat router serializes as SSE:
    routing      {agent}
    message_start{agent}
    text_delta   {text}
    tool_call    {name, status: started|finished|failed, summary?}
    viz_block    {type, data}
    message_end  {message}
    error        {message}

The agent reply is persisted in `finally`, so a client disconnect mid-stream
never loses the message.
"""

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

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


def _serialize_message(message: ChatMessage) -> dict[str, Any]:
    return {
        "id": str(message.id),
        "thread_id": str(message.thread_id),
        "role": message.role,
        "agent_name": message.agent_name,
        "content": message.content,
        "viz": message.viz,
        "created_at": message.created_at.isoformat(),
    }


async def run_turn(
    sessionmaker: async_sessionmaker[AsyncSession],
    graph,
    registry,
    thread_id: uuid.UUID,
    content: str,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    async with sessionmaker() as session:
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
        viz_blocks: list[dict[str, Any]] = []
        tool_trace: list[dict[str, Any]] = []

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
                iteration_text = ""
                tool_calls: list[ToolCallEvent] = []
                failed = False

                async for event in provider.stream(model, system, messages, tools):
                    if isinstance(event, TextDelta):
                        iteration_text += event.text
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

                if iteration_text:
                    text_parts.append(iteration_text)
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
                    yield ("tool_call", {"name": tc.name, "status": "started"})
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
                    tool_trace.append(
                        {"name": tc.name, "arguments": tc.arguments, "status": status}
                    )
                    yield ("tool_call", {"name": tc.name, "status": status})
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

        finally:
            agent_message = ChatMessage(
                thread_id=thread_id,
                role="agent",
                agent_name=agent_name,
                content="\n\n".join(part for part in text_parts if part).strip(),
                viz=viz_blocks,
                tool_calls=tool_trace or None,
            )
            session.add(agent_message)
            await session.commit()
            await session.refresh(agent_message)

        yield ("message_end", {"message": _serialize_message(agent_message)})
