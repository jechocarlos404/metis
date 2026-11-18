import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.agents import proposals as proposal_service
from app.agents.runner import start_turn
from app.db import get_db
from app.models import ChatMessage, ChatThread
from app.schemas.chat import MessageRead, MessageSend, ProposalRead, ThreadCreate, ThreadRead

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.get("/status")
async def chat_status(request: Request):
    """Whether any LLM provider can answer, so the UI can say chat is
    unavailable before someone types. Readable by every role; provider names
    and details stay behind the admin LLM config."""
    statuses = await request.app.state.llm.statuses()
    return {"available": any(s.available for s in statuses)}


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
        ChatThread,
        thread_id,
        options=[selectinload(ChatThread.messages).selectinload(ChatMessage.proposals)],
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


@router.post("/threads/{thread_id}/messages", status_code=202)
async def send_message(thread_id: uuid.UUID, data: MessageSend, request: Request):
    """Starts the turn in the background and returns at once. The reply is
    saved as it is written: read it with GET /threads/{id}/messages, where
    `status` says whether each reply is still running."""
    state = request.app.state
    try:
        return await start_turn(state.sessionmaker, state.graph, state.llm, thread_id, data.content, state.runs)
    except LookupError as e:
        raise HTTPException(404, str(e))


def _decide_errors(fn):
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except proposal_service.ProposalConflict as e:
            raise HTTPException(409, str(e))
    return wrapper


@router.post("/proposals/{proposal_id}/approve", response_model=ProposalRead)
async def approve_proposal(proposal_id: uuid.UUID, request: Request):
    """Apply one proposed change. Editors and admins only (writes)."""
    state = request.app.state
    return await _decide_errors(proposal_service.approve)(state.sessionmaker, state.graph, proposal_id)


@router.post("/proposals/{proposal_id}/reject", response_model=ProposalRead)
async def reject_proposal(proposal_id: uuid.UUID, request: Request):
    return await _decide_errors(proposal_service.reject)(request.app.state.sessionmaker, proposal_id)


@router.post("/messages/{message_id}/approve-all", response_model=list[ProposalRead])
async def approve_all(message_id: uuid.UUID, request: Request):
    """Every pending change of one reply, in order, stopping at the first failure."""
    state = request.app.state
    return await _decide_errors(proposal_service.approve_all)(state.sessionmaker, state.graph, message_id)
