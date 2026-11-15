"""Teacher journal scope; independent of the scheduled lesson teacher."""

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    UniqueConstraint,
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
