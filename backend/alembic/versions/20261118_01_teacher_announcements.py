"""Add immutable teacher announcements."""

import sqlalchemy as sa

from alembic import op

revision = "20261118_01"
down_revision = "20261117_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "teacher_announcements",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "course_offering_id",
            sa.BigInteger(),
            sa.ForeignKey("course_offerings.id"),
            nullable=False,
        ),
        sa.Column("teacher_id", sa.BigInteger(), sa.ForeignKey("teachers.id"), nullable=False),
        sa.Column("group_id", sa.BigInteger(), sa.ForeignKey("study_groups.id")),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("is_important", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.statement_timestamp(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["course_offering_id", "group_id"],
            ["course_groups.course_offering_id", "course_groups.group_id"],
            name="fk_teacher_announcements_course_group",
        ),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="title_length"),
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 20000", name="body_length"),
    )
    op.create_index(
        "ix_teacher_announcements_course_group_created",
        "teacher_announcements",
        ["course_offering_id", "group_id", "created_at", "id"],
    )
    op.create_index("ix_teacher_announcements_teacher_id", "teacher_announcements", ["teacher_id"])


def downgrade() -> None:
    op.drop_table("teacher_announcements")
