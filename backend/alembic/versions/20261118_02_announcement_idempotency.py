"""Persist publication idempotency keys."""

import sqlalchemy as sa

from alembic import op

revision = "20261118_02"
down_revision = "20261118_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("teacher_announcements", sa.Column("publication_key", sa.Uuid()))
    op.create_unique_constraint(
        "uq_teacher_announcement_publication",
        "teacher_announcements",
        ["teacher_id", "publication_key"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_teacher_announcement_publication", "teacher_announcements", type_="unique"
    )
    op.drop_column("teacher_announcements", "publication_key")
