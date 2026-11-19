"""Clear invalid legacy notification target IDs."""

from collections.abc import Sequence

from alembic import op

revision: str = "20261119_02"
down_revision: str | Sequence[str] | None = "20261119_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 20261119_01 added a NOT VALID check to protect new writes without
    # rejecting historical rows. Null only the invalid target identifier;
    # retain notification text, type, recipient, and read state.
    op.execute("UPDATE notifications SET entity_id = NULL WHERE entity_id <= 0")
    op.execute("ALTER TABLE notifications VALIDATE CONSTRAINT ck_notifications_entity_id_positive")


def downgrade() -> None:
    # The original invalid values cannot be reconstructed after normalization.
    pass
