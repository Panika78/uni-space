"""Create university news table.

Revision ID: 20261111_02
Revises: 20261110_01
Create Date: 2026-11-11
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261111_02"
down_revision: str | Sequence[str] | None = "20261110_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "news",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("author_user_id", sa.BigInteger(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_published", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint("title !~ '^[[:space:]]*$'", name="ck_news_title_not_blank"),
        sa.ForeignKeyConstraint(
            ["author_user_id"], ["users.id"], name="fk_news_author_user_id_users"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_news"),
    )
    op.create_index("ix_news_published_at_id", "news", ["published_at", "id"])


def downgrade() -> None:
    op.drop_index("ix_news_published_at_id", table_name="news")
    op.drop_table("news")
