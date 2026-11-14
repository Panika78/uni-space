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


class Subgroup(Base):
    __tablename__ = "subgroups"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_subgroups"),
        UniqueConstraint("group_id", "id", name="uq_subgroups_group_id_id"),
        Index("ix_subgroups_group_id", "group_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("study_groups.id", name="fk_subgroups_group_id_study_groups"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)


class Student(Base):
    __tablename__ = "students"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_students_user_id"),
        PrimaryKeyConstraint("id", name="pk_students"),
        CheckConstraint(
            "academic_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_students_academic_status",
        ),
        Index("ix_students_group_id", "group_id"),
        ForeignKeyConstraint(
            ["group_id", "subgroup_id"],
            ["subgroups.group_id", "subgroups.id"],
            name="fk_students_group_subgroup",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", name="fk_students_user_id_users"), nullable=False
    )
    group_id: Mapped[int] = mapped_column(
        ForeignKey("study_groups.id", name="fk_students_group_id_study_groups"), nullable=False
    )
    subgroup_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    academic_status: Mapped[str] = mapped_column(String, nullable=False)


class Teacher(Base):
    __tablename__ = "teachers"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_teachers_user_id"),
        PrimaryKeyConstraint("id", name="pk_teachers"),
        Index("ix_teachers_department_id", "department_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    full_name: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="fk_teachers_user_id_users"), nullable=True
    )
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_teachers_department_id_org_units"), nullable=True
    )
