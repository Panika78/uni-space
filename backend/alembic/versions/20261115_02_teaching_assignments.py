"""Add teacher journal assignments.

Revision ID: 20261115_02
Revises: 20261115_01
"""

import sqlalchemy as sa

from alembic import op

revision = "20261115_02"
down_revision = "20261115_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "teaching_assignments",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("course_offering_id", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.Column("teacher_id", sa.BigInteger(), sa.ForeignKey("teachers.id"), nullable=False),
        sa.ForeignKeyConstraint(
            ["course_offering_id", "group_id"],
            ["course_groups.course_offering_id", "course_groups.group_id"],
            name="fk_teaching_assignments_course_group",
        ),
        sa.UniqueConstraint(
            "course_offering_id",
            "group_id",
            "teacher_id",
            name="uq_teaching_assignments_course_group_teacher",
        ),
    )
    op.create_index("ix_teaching_assignments_teacher_id", "teaching_assignments", ["teacher_id"])


def downgrade() -> None:
    op.drop_table("teaching_assignments")
