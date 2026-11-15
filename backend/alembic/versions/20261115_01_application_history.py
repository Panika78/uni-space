"""Create application history without backfilling synthetic events.

Revision ID: 20261115_01
Revises: 20261114_03
"""

import sqlalchemy as sa

from alembic import op

revision = "20261115_01"
down_revision = "20261114_03"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "application_history",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("application_id", sa.BigInteger(), nullable=False),
        sa.Column("actor_user_id", sa.BigInteger(), nullable=True),
        sa.Column("from_status", sa.String(), nullable=True),
        sa.Column("to_status", sa.String(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("statement_timestamp()"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_application_history"),
        sa.ForeignKeyConstraint(
            ["application_id"],
            ["applications.id"],
            ondelete="CASCADE",
            name="fk_application_history_application_id_applications",
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"], ["users.id"], name="fk_application_history_actor_user_id_users"
        ),
    )
    op.create_index(
        "ix_application_history_application_created_id",
        "application_history",
        ["application_id", "created_at", "id"],
    )


def downgrade():
    op.drop_index("ix_application_history_application_created_id", table_name="application_history")
    op.drop_table("application_history")
