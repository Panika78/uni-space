"""Add private current application attachment metadata."""

import sqlalchemy as sa

from alembic import op

revision = "20261116_09"
down_revision = "20261116_08"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "application_attachments",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("application_id", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.String(length=100), nullable=False),
        sa.Column("original_filename", sa.String(length=200), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("is_current", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "uploaded_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False
        ),
        sa.CheckConstraint("size_bytes > 0 AND size_bytes <= 10485760", name="ck_application_attachments_size"),
        sa.CheckConstraint("mime_type IN ('application/pdf','image/jpeg','image/png')", name="ck_application_attachments_mime"),
        sa.ForeignKeyConstraint(
            ["application_id"], ["applications.id"],
            name="fk_application_attachments_application_id_applications", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_application_attachments"),
        sa.UniqueConstraint("storage_key", name="uq_application_attachments_storage_key"),
    )
    op.create_index(
        "ix_application_attachments_application_current",
        "application_attachments", ["application_id", "is_current"]
    )


def downgrade():
    op.drop_index("ix_application_attachments_application_current", table_name="application_attachments")
    op.drop_table("application_attachments")
