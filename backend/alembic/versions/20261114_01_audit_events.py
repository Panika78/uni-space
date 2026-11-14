"""Create shared audit events.

Revision ID: 20261114_01
Revises: 20261112_03
Create Date: 2026-11-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261114_01"
down_revision: str | Sequence[str] | None = "20261112_03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("actor_user_id", sa.BigInteger(), nullable=True),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("before_data", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("after_data", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("statement_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"], ["users.id"], name="fk_audit_events_actor_user_id_users"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_audit_events_entity_created_id",
        "audit_events",
        ["entity_type", "entity_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_audit_events_entity_created_id", table_name="audit_events")
    op.drop_table("audit_events")
