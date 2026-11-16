"""Add news optimistic versions and scoped create idempotency."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261116_01"
down_revision = "20261115_03"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("news", sa.Column("version", sa.Integer(), server_default="1", nullable=False))
    op.create_check_constraint("ck_news_version", "news", "version > 0")
    op.create_table(
        "news_create_requests",
        sa.Column("actor_user_id", sa.BigInteger(), nullable=False),
        sa.Column("org_unit_id", sa.BigInteger(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("news_id", sa.BigInteger(), nullable=True),
        sa.Column("response_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint(
            "actor_user_id", "org_unit_id", "idempotency_key", name="pk_news_create_requests"
        ),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_unit_id"], ["org_units.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["news_id"], ["news.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "(news_id IS NULL AND response_data IS NULL) OR "
            "(news_id IS NOT NULL AND response_data IS NOT NULL)",
            name="ck_news_create_requests_result",
        ),
    )


def downgrade():
    op.drop_table("news_create_requests")
    op.drop_constraint("ck_news_version", "news", type_="check")
    op.drop_column("news", "version")
