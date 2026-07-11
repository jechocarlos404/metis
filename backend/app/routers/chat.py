import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.agents.runner import run_turn
from app.db import get_db
from app.models import ChatThread
from app.schemas.chat import MessageRead, MessageSend, ThreadCreate, ThreadRead

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.get("/threads", response_model=list[ThreadRead])
async def list_threads(session: AsyncSession = Depends(get_db)):
    stmt = select(ChatThread).order_by(ChatThread.updated_at.desc())
    return (await session.scalars(stmt)).all()


@router.post("/threads", response_model=ThreadRead, status_code=201)
async def create_thread(data: ThreadCreate, session: AsyncSession = Depends(get_db)):
    thread = ChatThread(title=data.title)
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return thread


@router.get("/threads/{thread_id}", response_model=ThreadRead)
async def get_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    thread = await session.get(ChatThread, thread_id)
    if thread is None:
        raise HTTPException(404, "Thread not found")
    return thread


@router.get("/threads/{thread_id}/messages", response_model=list[MessageRead])
async def list_messages(thread_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    thread = await session.get(
        ChatThread, thread_id, options=[selectinload(ChatThread.messages)]
    )
    if thread is None:
        raise HTTPException(404, "Thread not found")
    return thread.messages


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    thread = await session.get(ChatThread, thread_id)
    if thread is None:
        raise HTTPException(404, "Thread not found")
    await session.delete(thread)
    await session.commit()


@router.post("/threads/{thread_id}/messages")
async def send_message(thread_id: uuid.UUID, data: MessageSend, request: Request):
    """Streams the agent turn as SSE:
    routing -> message_start -> text_delta* -> tool_call/viz_block* -> message_end
    """
    state = request.app.state
    thread_exists = None
    async with state.sessionmaker() as session:
        thread_exists = await session.get(ChatThread, thread_id)
    if thread_exists is None:
        raise HTTPException(404, "Thread not found")

    async def event_source():
        async for name, payload in run_turn(
            state.sessionmaker, state.graph, state.llm, thread_id, data.content
        ):
            yield {"event": name, "data": json.dumps(payload)}

    return EventSourceResponse(
        event_source(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
