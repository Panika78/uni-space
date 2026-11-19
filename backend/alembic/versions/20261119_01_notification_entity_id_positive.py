"""Prevent invalid notification target IDs for new rows."""

from collections.abc import Sequence

from alembic import op

revision: str = "20261119_01"
down_revision: str | Sequence[str] | None = "20261118_04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # NOT VALID preserves legacy malformed rows while PostgreSQL enforces the
    # condition for all new/updated rows from this point forward.
    op.execute(
        "ALTER TABLE notifications ADD CONSTRAINT "
        "ck_notifications_entity_id_positive "
        "CHECK (entity_id IS NULL OR entity_id > 0) NOT VALID"
    )


def downgrade() -> None:
    op.drop_constraint("ck_notifications_entity_id_positive", "notifications", type_="check")
