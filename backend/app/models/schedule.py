"""MVP academic offerings and concrete lessons; no editor or recurrence model."""

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
    String,
    UniqueConstraint,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AcademicTerm(Base):
    __tablename__ = "academic_terms"
    __table_args__ = (CheckConstraint("ends_on >= starts_on", name="ck_academic_terms_dates"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    starts_on: Mapped[date] = mapped_column(Date)
    ends_on: Mapped[date] = mapped_column(Date)


class Discipline(Base):
    __tablename__ = "disciplines"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    code: Mapped[str | None] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)


class CourseOffering(Base):
    __tablename__ = "course_offerings"
    __table_args__ = (
        CheckConstraint(
            "attestation_type IN ('exam', 'pass_fail', 'graded_pass')",
            name="ck_course_offerings_attestation_type",
        ),
        Index("ix_course_offerings_discipline_id", "discipline_id"),
        Index("ix_course_offerings_term_id", "term_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    discipline_id: Mapped[int] = mapped_column(ForeignKey("disciplines.id"))
    term_id: Mapped[int] = mapped_column(ForeignKey("academic_terms.id"))
    attestation_type: Mapped[str] = mapped_column(String)


class CourseGroup(Base):
    __tablename__ = "course_groups"
    __table_args__ = (Index("ix_course_groups_group_id", "group_id"),)

    course_offering_id: Mapped[int] = mapped_column(
        ForeignKey("course_offerings.id"), primary_key=True
    )
    group_id: Mapped[int] = mapped_column(ForeignKey("study_groups.id"), primary_key=True)


class Building(Base):
    __tablename__ = "buildings"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    address: Mapped[str | None] = mapped_column(String)


class Room(Base):
    __tablename__ = "rooms"
    __table_args__ = (UniqueConstraint("building_id", "name", name="uq_rooms_building_name"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id"))
    name: Mapped[str] = mapped_column(String)


class Lesson(Base):
    __tablename__ = "lessons"
    __table_args__ = (
        CheckConstraint("ends_at > starts_at", name="ck_lessons_times"),
        CheckConstraint("kind IN ('lecture', 'seminar', 'lab', 'other')", name="ck_lessons_kind"),
        CheckConstraint("status IN ('scheduled', 'cancelled', 'moved')", name="ck_lessons_status"),
        CheckConstraint("version > 0", name="ck_lessons_version"),
        CheckConstraint("previous_lesson_id <> id", name="ck_lessons_previous_not_self"),
        UniqueConstraint("previous_lesson_id", name="uq_lessons_previous_lesson_id"),
        Index("ix_lessons_times", "starts_at", "ends_at"),
        Index("ix_lessons_teacher_starts", "teacher_id", "starts_at"),
        Index("ix_lessons_course_offering_id", "course_offering_id"),
        Index("ix_lessons_created_by_user_id", "created_by_user_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    course_offering_id: Mapped[int] = mapped_column(ForeignKey("course_offerings.id"))
    teacher_id: Mapped[int | None] = mapped_column(ForeignKey("teachers.id"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, server_default="scheduled")
    previous_lesson_id: Mapped[int | None] = mapped_column(ForeignKey("lessons.id"))
    is_additional: Mapped[bool] = mapped_column(Boolean, server_default=false())
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(server_default=text("1"))


class LessonGroup(Base):
    __tablename__ = "lesson_groups"
    __table_args__ = (
        UniqueConstraint("lesson_id", "group_id", name="uq_lesson_groups_lesson_group"),
        Index("ix_lesson_groups_group_lesson", "group_id", "lesson_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    lesson_id: Mapped[int] = mapped_column(ForeignKey("lessons.id"))
    group_id: Mapped[int] = mapped_column(ForeignKey("study_groups.id"))


class LessonRoom(Base):
    __tablename__ = "lesson_rooms"
    __table_args__ = (Index("ix_lesson_rooms_room_lesson", "room_id", "lesson_id"),)

    lesson_id: Mapped[int] = mapped_column(ForeignKey("lessons.id"), primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id"), primary_key=True)
