import uuid
from typing import Any

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin


class ChatThread(PKMixin, TimestampMixin, Base):
    __tablename__ = "chat_threads"

    title: Mapped[str] = mapped_column(Text, default="New thread")

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="thread",
        cascade="all, delete-orphan",
        order_by="ChatMessage.seq",
    )


class ChatMessage(PKMixin, TimestampMixin, Base):
    __tablename__ = "chat_messages"

    thread_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("chat_threads.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(Text)  # user | agent | system
    agent_name: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, default="")
    viz: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    tool_calls: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    #: running | done | failed | interrupted. Agent replies run in the
    #: background and are saved as they go; a restart leaves "interrupted".
    status: Mapped[str] = mapped_column(Text, default="done", server_default="done")
    #: A specialist's reply points at the orchestrator reply that delegated it.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE")
    )
    #: What the orchestrator asked this specialist to do.
    task: Mapped[str | None] = mapped_column(Text)

    thread: Mapped[ChatThread] = relationship(back_populates="messages")
    proposals: Mapped[list["ChatProposal"]] = relationship(
        back_populates="message", cascade="all, delete-orphan", order_by="ChatProposal.seq"
    )


class ChatProposal(PKMixin, TimestampMixin, Base):
    """A change an agent wants to make. Nothing is written until a person
    approves it; then the tool runs exactly once."""

    __tablename__ = "chat_proposals"

    message_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE"), index=True
    )
    tool_name: Mapped[str] = mapped_column(Text)
    arguments: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    #: pending | applying | applied | rejected | failed
    status: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    #: What happened when it was applied (or why it failed).
    result: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    message: Mapped[ChatMessage] = relationship(back_populates="proposals")
