"""Add event identity and recipient uniqueness to notifications."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261119_03"
down_revision: str | Sequence[str] | None = "20261119_02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("logical_event_key", sa.String(120), nullable=True))
    op.create_unique_constraint(
        "uq_notifications_logical_event_recipient",
        "notifications",
        ["logical_event_key", "user_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_notifications_logical_event_recipient", "notifications", type_="unique"
    )
    op.drop_column("notifications", "logical_event_key")
