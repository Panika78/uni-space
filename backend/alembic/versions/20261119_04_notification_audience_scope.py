"""Retain group scope for current notification access checks."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261119_04"
down_revision: str | Sequence[str] | None = "20261119_03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("audience_group_id", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("notifications", "audience_group_id")
