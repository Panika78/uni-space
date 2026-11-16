"""Independent per-lesson attendance; missing row means unmarked."""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Attendance(Base):
    __tablename__ = "attendance"
    __table_args__ = (
        CheckConstraint("status IN ('attended', 'absent')", name="ck_attendance_status"),
        Index("ix_attendance_student_lesson", "student_id", "lesson_id"),
        ForeignKeyConstraint(
            ["origin_group_id"], ["study_groups.id"], name="fk_attendance_origin_group"
        ),
        ForeignKeyConstraint(
            ["origin_group_id", "origin_subgroup_id"],
            ["subgroups.group_id", "subgroups.id"],
            name="fk_attendance_origin_subgroup",
        ),
        CheckConstraint(
            "(origin_group_id IS NULL AND origin_subgroup_id IS NULL "
            "AND membership_version IS NULL) "
            "OR (origin_group_id IS NOT NULL AND membership_version IS NOT NULL "
            "AND membership_version >= 0)",
            name="ck_attendance_origin",
        ),
    )
    lesson_id: Mapped[int] = mapped_column(ForeignKey("lessons.id"), primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), primary_key=True)
    origin_group_id: Mapped[int | None] = mapped_column(BigInteger)
    origin_subgroup_id: Mapped[int | None] = mapped_column(BigInteger)
    membership_version: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String)
    marked_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
