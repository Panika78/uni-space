from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    PrimaryKeyConstraint,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class OrgUnit(Base):
    __tablename__ = "org_units"
    __table_args__ = (
        CheckConstraint(
            "type IN ('faculty', 'department', 'dean_office', 'accounting')",
            name="ck_org_units_type",
        ),
        PrimaryKeyConstraint("id", name="pk_org_units"),
        Index("ix_org_units_parent_id", "parent_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_org_units_parent_id_org_units"), nullable=True
    )


class Program(Base):
    __tablename__ = "programs"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_programs"),
        Index("ix_programs_faculty_id", "faculty_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    code: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    direction_code: Mapped[str] = mapped_column(String, nullable=False)
    direction_name: Mapped[str] = mapped_column(String, nullable=False)
    faculty_id: Mapped[int] = mapped_column(
        ForeignKey("org_units.id", name="fk_programs_faculty_id_org_units"), nullable=False
    )


class StudyGroup(Base):
    __tablename__ = "study_groups"
    __table_args__ = (
        CheckConstraint("course_number > 0", name="ck_study_groups_course_number"),
        PrimaryKeyConstraint("id", name="pk_study_groups"),
        Index("ix_study_groups_program_id", "program_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    program_id: Mapped[int] = mapped_column(
        ForeignKey("programs.id", name="fk_study_groups_program_id_programs"), nullable=False
    )
    course_number: Mapped[int] = mapped_column(nullable=False)


class Student(Base):
    # Database-only discriminator; callers cannot edit the profile role through the ORM.
    __mapper_args__ = {"exclude_properties": ["profile_role"]}
    __tablename__ = "students"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_students_user_id"),
        CheckConstraint("profile_role = 'student'", name="ck_students_profile_role"),
        ForeignKeyConstraint(
            ["user_id", "profile_role"],
            ["users.id", "users.role"],
            name="fk_students_user_role",
            deferrable=True,
            initially="DEFERRED",
        ),
        PrimaryKeyConstraint("id", name="pk_students"),
        CheckConstraint(
            "academic_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_students_academic_status",
        ),
        Index("ix_students_group_id", "group_id"),
    )

    profile_role: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'student'")
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("study_groups.id", name="fk_students_group_id_study_groups"), nullable=False
    )
    academic_status: Mapped[str] = mapped_column(String, nullable=False)


class Teacher(Base):
    # Database-only discriminator; callers cannot edit the profile role through the ORM.
    __mapper_args__ = {"exclude_properties": ["profile_role"]}
    __tablename__ = "teachers"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_teachers_user_id"),
        CheckConstraint("profile_role = 'teacher'", name="ck_teachers_profile_role"),
        ForeignKeyConstraint(
            ["user_id", "profile_role"],
            ["users.id", "users.role"],
            name="fk_teachers_user_role",
            deferrable=True,
            initially="DEFERRED",
        ),
        PrimaryKeyConstraint("id", name="pk_teachers"),
        Index("ix_teachers_department_id", "department_id"),
    )

    profile_role: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'teacher'")
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    full_name: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_teachers_department_id_org_units"), nullable=True
    )
