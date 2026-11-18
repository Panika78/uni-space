"""Teacher journal scope; independent of the scheduled lesson teacher."""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Text,
    UniqueConstraint,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TeachingAssignment(Base):
    __tablename__ = "teaching_assignments"
    __table_args__ = (
        ForeignKeyConstraint(
            ["course_offering_id", "group_id"],
            ["course_groups.course_offering_id", "course_groups.group_id"],
            name="fk_teaching_assignments_course_group",
        ),
        UniqueConstraint(
            "course_offering_id",
            "group_id",
            "teacher_id",
            name="uq_teaching_assignments_course_group_teacher",
        ),
        Index("ix_teaching_assignments_teacher_id", "teacher_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    course_offering_id: Mapped[int] = mapped_column(BigInteger)
    group_id: Mapped[int] = mapped_column(BigInteger)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("teachers.id"))


class TeacherAnnouncement(Base):
    __tablename__ = "teacher_announcements"
    __table_args__ = (
        ForeignKeyConstraint(
            ["course_offering_id", "group_id"],
            ["course_groups.course_offering_id", "course_groups.group_id"],
            name="fk_teacher_announcements_course_group",
        ),
        CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="title_length"),
        CheckConstraint("char_length(body) BETWEEN 1 AND 20000", name="body_length"),
        Index(
            "ix_teacher_announcements_course_group_created",
            "course_offering_id",
            "group_id",
            "created_at",
            "id",
        ),
        Index("ix_teacher_announcements_teacher_id", "teacher_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    course_offering_id: Mapped[int] = mapped_column(ForeignKey("course_offerings.id"))
    teacher_id: Mapped[int] = mapped_column(ForeignKey("teachers.id"))
    group_id: Mapped[int | None] = mapped_column(ForeignKey("study_groups.id"))
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    is_important: Mapped[bool] = mapped_column(Boolean, server_default=false())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.statement_timestamp()
    )
