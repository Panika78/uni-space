"""Durable idempotency receipts for staff academic status commands."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class StudentStatusOperation(Base):
    __tablename__ = "student_status_operations"
    __table_args__ = (
        CheckConstraint(
            "target_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_student_status_operations_target_status",
        ),
        CheckConstraint(
            "previous_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_student_status_operations_previous_status",
        ),
        CheckConstraint(
            "reason IN ('administrative_change', 'correction')",
            name="ck_student_status_operations_reason",
        ),
        CheckConstraint(
            "changed = (previous_status <> target_status)",
            name="ck_student_status_operations_changed",
        ),
    )

    operation_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), nullable=False)
    target_status: Mapped[str] = mapped_column(String, nullable=False)
    previous_status: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[str] = mapped_column(String, nullable=False)
    changed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.statement_timestamp()
    )
