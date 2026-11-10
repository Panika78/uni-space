"""Add service catalog and student applications.

Revision ID: 20261110_01
Revises: 20261109_01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261110_01"
down_revision: str | Sequence[str] | None = "20261109_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "service_types",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("processing_mode", sa.String(), nullable=False),
        sa.Column("responsible_org_unit_id", sa.BigInteger(), nullable=True),
        sa.Column("produces_document", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["responsible_org_unit_id"],
            ["org_units.id"],
            name="fk_service_types_responsible_org_unit_id_org_units",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_service_types"),
        sa.UniqueConstraint("code", name="uq_service_types_code"),
    )
    op.create_table(
        "applications",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), primary_key=True),
        sa.Column("student_id", sa.BigInteger(), nullable=False),
        sa.Column("service_type_id", sa.BigInteger(), nullable=False),
        sa.Column("review_status", sa.String(), nullable=False),
        sa.Column("document_status", sa.String(), nullable=False),
        sa.Column("form_data", postgresql.JSONB(), nullable=False),
        sa.Column("assigned_org_unit_id", sa.BigInteger(), nullable=True),
        sa.Column("reviewer_user_id", sa.BigInteger(), nullable=True),
        sa.Column("feedback", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.CheckConstraint(
            "review_status IN ('submitted','in_review','needs_correction','resubmitted',"
            "'approved','rejected')",
            name="ck_applications_review_status",
        ),
        sa.CheckConstraint(
            "document_status IN ('not_required','pending','ready','failed')",
            name="ck_applications_document_status",
        ),
        sa.CheckConstraint("version > 0", name="ck_applications_version"),
        sa.ForeignKeyConstraint(
            ["student_id"], ["students.id"], name="fk_applications_student_id_students"
        ),
        sa.ForeignKeyConstraint(
            ["service_type_id"],
            ["service_types.id"],
            name="fk_applications_service_type_id_service_types",
        ),
        sa.ForeignKeyConstraint(
            ["assigned_org_unit_id"],
            ["org_units.id"],
            name="fk_applications_assigned_org_unit_id_org_units",
        ),
        sa.ForeignKeyConstraint(
            ["reviewer_user_id"], ["users.id"], name="fk_applications_reviewer_user_id_users"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_applications"),
    )
    op.create_index(
        "ix_applications_student_id_created_at", "applications", ["student_id", "created_at"]
    )
    op.create_index("ix_applications_service_type_id", "applications", ["service_type_id"])
    op.create_index(
        "ix_applications_assigned_org_unit_id_review_status",
        "applications",
        ["assigned_org_unit_id", "review_status"],
    )
    op.create_index("ix_applications_reviewer_user_id", "applications", ["reviewer_user_id"])
    op.create_index(
        "ix_service_types_responsible_org_unit_id", "service_types", ["responsible_org_unit_id"]
    )
    op.execute(
        "INSERT INTO service_types (code,title,processing_mode,produces_document) "
        "VALUES ('study_certificate','Справка об обучении','automatic',true) "
        "ON CONFLICT (code) DO NOTHING"
    )


def downgrade() -> None:
    op.drop_table("applications")
    op.drop_table("service_types")
