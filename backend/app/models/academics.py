"""Read-only MVP grading data; no journal/editor or maximum lock (MVP 2)."""

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Assessment(Base):
    __tablename__ = "assessments"
    __table_args__ = (
        CheckConstraint("max_score >= 0", name="ck_assessments_max_score"),
        Index("ix_assessments_course_offering_id", "course_offering_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    course_offering_id: Mapped[int] = mapped_column(ForeignKey("course_offerings.id"))
    title: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    max_score: Mapped[int] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(String)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class AssessmentGroup(Base):
    __tablename__ = "assessment_groups"
    __table_args__ = (
        UniqueConstraint("assessment_id", "group_id", name="uq_assessment_groups_assessment_group"),
        Index("ix_assessment_groups_group_date", "group_id", "planned_date"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    assessment_id: Mapped[int] = mapped_column(ForeignKey("assessments.id"))
    group_id: Mapped[int] = mapped_column(ForeignKey("study_groups.id"))
    planned_date: Mapped[date | None] = mapped_column(Date)
    lesson_id: Mapped[int | None] = mapped_column(ForeignKey("lessons.id"))
    date_needs_confirmation: Mapped[bool] = mapped_column(Boolean, server_default=false())


class AssessmentResult(Base):
    __tablename__ = "assessment_results"
    __table_args__ = (
        UniqueConstraint(
            "assessment_group_id", "student_id", name="uq_assessment_results_assignment_student"
        ),
        CheckConstraint("score >= 0", name="ck_assessment_results_score"),
        Index("ix_assessment_results_student_assignment", "student_id", "assessment_group_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    assessment_group_id: Mapped[int] = mapped_column(ForeignKey("assessment_groups.id"))
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"))
    score: Mapped[int] = mapped_column(Integer)
    graded_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    graded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FinalResult(Base):
    __tablename__ = "final_results"
    __table_args__ = (
        UniqueConstraint(
            "course_offering_id", "student_id", name="uq_final_results_offering_student"
        ),
        CheckConstraint(
            "grade_value IS NULL OR grade_value BETWEEN 2 AND 5", name="ck_final_results_grade"
        ),
        CheckConstraint(
            "grade_value IS NULL OR passed IS NULL", name="ck_final_results_single_kind"
        ),
        CheckConstraint(
            "grade_value IS NOT NULL OR passed IS NOT NULL "
            "OR retake_date IS NOT NULL OR retake_location IS NOT NULL",
            name="ck_final_results_not_empty",
        ),
        Index("ix_final_results_student_offering", "student_id", "course_offering_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    course_offering_id: Mapped[int] = mapped_column(ForeignKey("course_offerings.id"))
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"))
    grade_value: Mapped[int | None] = mapped_column(Integer)
    passed: Mapped[bool | None] = mapped_column(Boolean)
    retake_date: Mapped[date | None] = mapped_column(Date)
    retake_location: Mapped[str | None] = mapped_column(String)
