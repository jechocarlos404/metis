import uuid

from sqlalchemy import Enum, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import GoalType, WorkStatus


class Goal(PKMixin, TimestampMixin, Base):
    __tablename__ = "goals"

    goal_type: Mapped[GoalType] = mapped_column(Enum(GoalType, native_enum=False))
    parent_goal_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("goals.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    success_criteria: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False), default=WorkStatus.pending
    )

    children: Mapped[list["Goal"]] = relationship(
        remote_side="Goal.parent_goal_id",
        primaryjoin="Goal.id == foreign(Goal.parent_goal_id)",
        viewonly=True,
    )
