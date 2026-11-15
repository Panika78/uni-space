"""Store the implemented schedule preference per account."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261115_03"
down_revision = "20261115_02"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_preferences",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("preferences", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_user_preferences"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_user_preferences_user_id_users", ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(preferences) = 'object' AND "
            "preferences ? 'show_cancelled_lessons' AND "
            "preferences - 'show_cancelled_lessons' = '{}'::jsonb AND "
            "jsonb_typeof(preferences -> 'show_cancelled_lessons') = 'boolean'",
            name="ck_user_preferences_values",
        ),
    )


def downgrade():
    op.drop_table("user_preferences")
