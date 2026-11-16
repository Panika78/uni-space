"""Add independent lesson attendance."""

import sqlalchemy as sa

from alembic import op

revision = "20261116_02"
down_revision = "20261116_01"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "attendance",
        sa.Column("lesson_id", sa.BigInteger(), sa.ForeignKey("lessons.id"), primary_key=True),
        sa.Column("student_id", sa.BigInteger(), sa.ForeignKey("students.id"), primary_key=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("marked_by_user_id", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("status IN ('attended', 'absent')", name="ck_attendance_status"),
    )
    op.create_index("ix_attendance_student_lesson", "attendance", ["student_id", "lesson_id"])


def downgrade():
    op.drop_table("attendance")
