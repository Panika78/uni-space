"""Add immutable issued document metadata."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261117_01"
down_revision = "20261116_09"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "issued_documents",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("application_id", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.String(length=100), nullable=False),
        sa.Column("filename", sa.String(length=200), nullable=False),
        sa.Column(
            "issued_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.statement_timestamp(),
            nullable=False,
        ),
        sa.Column("snapshot_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["application_id"],
            ["applications.id"],
            name="fk_issued_documents_application_id_applications",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_issued_documents"),
        sa.UniqueConstraint("application_id", name="uq_issued_documents_application_id"),
        sa.UniqueConstraint("storage_key", name="uq_issued_documents_storage_key"),
    )


def downgrade():
    op.drop_table("issued_documents")
