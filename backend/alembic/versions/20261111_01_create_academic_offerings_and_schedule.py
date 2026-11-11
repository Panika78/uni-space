"""Create academic offerings and schedule

Revision ID: 20261111_01
Revises: 20261109_01
Create Date: 2026-11-10 21:29:15.422371
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261111_01"
down_revision: str | Sequence[str] | None = "20261109_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "academic_terms",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("ends_on", sa.Date(), nullable=False),
        sa.CheckConstraint("ends_on >= starts_on", name="ck_academic_terms_dates"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "buildings",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("address", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "disciplines",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("code", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "course_offerings",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("discipline_id", sa.BigInteger(), nullable=False),
        sa.Column("term_id", sa.BigInteger(), nullable=False),
        sa.Column("attestation_type", sa.String(), nullable=False),
        sa.CheckConstraint(
            "attestation_type IN ('exam', 'pass_fail', 'graded_pass')",
            name="ck_course_offerings_attestation_type",
        ),
        sa.ForeignKeyConstraint(
            ["discipline_id"],
            ["disciplines.id"],
        ),
        sa.ForeignKeyConstraint(
            ["term_id"],
            ["academic_terms.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_course_offerings_discipline_id", "course_offerings", ["discipline_id"], unique=False
    )
    op.create_index("ix_course_offerings_term_id", "course_offerings", ["term_id"], unique=False)
    op.create_table(
        "rooms",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("building_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("building_id", "name", name="uq_rooms_building_name"),
    )
    op.create_table(
        "lessons",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("course_offering_id", sa.BigInteger(), nullable=False),
        sa.Column("teacher_id", sa.BigInteger(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), server_default="scheduled", nullable=False),
        sa.Column("previous_lesson_id", sa.BigInteger(), nullable=True),
        sa.Column("is_additional", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.CheckConstraint(
            "kind IN ('lecture', 'seminar', 'lab', 'other')", name="ck_lessons_kind"
        ),
        sa.CheckConstraint(
            "status IN ('scheduled', 'cancelled', 'moved')", name="ck_lessons_status"
        ),
        sa.CheckConstraint("ends_at > starts_at", name="ck_lessons_times"),
        sa.CheckConstraint("previous_lesson_id <> id", name="ck_lessons_previous_not_self"),
        sa.CheckConstraint("version > 0", name="ck_lessons_version"),
        sa.ForeignKeyConstraint(
            ["course_offering_id"],
            ["course_offerings.id"],
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["previous_lesson_id"],
            ["lessons.id"],
        ),
        sa.ForeignKeyConstraint(
            ["teacher_id"],
            ["teachers.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("previous_lesson_id", name="uq_lessons_previous_lesson_id"),
    )
    op.create_index(
        "ix_lessons_course_offering_id", "lessons", ["course_offering_id"], unique=False
    )
    op.create_index(
        "ix_lessons_created_by_user_id", "lessons", ["created_by_user_id"], unique=False
    )
    op.create_index(
        "ix_lessons_teacher_starts", "lessons", ["teacher_id", "starts_at"], unique=False
    )
    op.create_index("ix_lessons_times", "lessons", ["starts_at", "ends_at"], unique=False)
    op.create_table(
        "course_groups",
        sa.Column("course_offering_id", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["course_offering_id"],
            ["course_offerings.id"],
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["study_groups.id"],
        ),
        sa.PrimaryKeyConstraint("course_offering_id", "group_id"),
    )
    op.create_index("ix_course_groups_group_id", "course_groups", ["group_id"], unique=False)
    op.create_table(
        "lesson_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("lesson_id", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["study_groups.id"],
        ),
        sa.ForeignKeyConstraint(
            ["lesson_id"],
            ["lessons.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("lesson_id", "group_id", name="uq_lesson_groups_lesson_group"),
    )
    op.create_index(
        "ix_lesson_groups_group_lesson", "lesson_groups", ["group_id", "lesson_id"], unique=False
    )
    op.create_table(
        "lesson_rooms",
        sa.Column("lesson_id", sa.BigInteger(), nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["lesson_id"],
            ["lessons.id"],
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
        ),
        sa.PrimaryKeyConstraint("lesson_id", "room_id"),
    )
    op.create_index(
        "ix_lesson_rooms_room_lesson", "lesson_rooms", ["room_id", "lesson_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_lesson_rooms_room_lesson", table_name="lesson_rooms")
    op.drop_table("lesson_rooms")
    op.drop_index("ix_lesson_groups_group_lesson", table_name="lesson_groups")
    op.drop_table("lesson_groups")
    op.drop_index("ix_course_groups_group_id", table_name="course_groups")
    op.drop_table("course_groups")
    op.drop_index("ix_lessons_times", table_name="lessons")
    op.drop_index("ix_lessons_teacher_starts", table_name="lessons")
    op.drop_index("ix_lessons_created_by_user_id", table_name="lessons")
    op.drop_index("ix_lessons_course_offering_id", table_name="lessons")
    op.drop_table("lessons")
    op.drop_table("rooms")
    op.drop_index("ix_course_offerings_term_id", table_name="course_offerings")
    op.drop_index("ix_course_offerings_discipline_id", table_name="course_offerings")
    op.drop_table("course_offerings")
    op.drop_table("disciplines")
    op.drop_table("buildings")
    op.drop_table("academic_terms")
