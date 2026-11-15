"""Independent per-lesson attendance; missing row means unmarked."""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Attendance(Base):
    __tablename__ = "attendance"
    __table_args__ = (
        CheckConstraint("status IN ('attended', 'absent')", name="ck_attendance_status"),
        Index("ix_attendance_student_lesson", "student_id", "lesson_id"),
    )
    lesson_id: Mapped[int] = mapped_column(ForeignKey("lessons.id"), primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), primary_key=True)
    status: Mapped[str] = mapped_column(String)
    marked_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
