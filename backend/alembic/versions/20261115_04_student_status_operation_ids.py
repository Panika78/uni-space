"""Add operation receipts to student status audit events.

Revision ID: 20261115_04
Revises: 20261115_03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261115_04"
down_revision: str | Sequence[str] | None = "20261115_03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_events", sa.Column("operation_id", sa.Uuid(as_uuid=False), nullable=True))
    op.add_column(
        "audit_events", sa.Column("operation_fingerprint", sa.String(length=64), nullable=True)
    )
    op.create_check_constraint(
        "ck_audit_events_status_operation_pair",
        "audit_events",
        "(operation_id IS NULL) = (operation_fingerprint IS NULL)",
    )
    op.create_check_constraint(
        "ck_audit_events_status_operation_shape",
        "audit_events",
        "operation_id IS NULL OR (entity_type = 'student' AND action = 'set_academic_status')",
    )
    op.create_index("uq_audit_events_operation_id", "audit_events", ["operation_id"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_audit_events_operation_id", table_name="audit_events")
    op.drop_constraint("ck_audit_events_status_operation_shape", "audit_events", type_="check")
    op.drop_constraint("ck_audit_events_status_operation_pair", "audit_events", type_="check")
    op.drop_column("audit_events", "operation_fingerprint")
    op.drop_column("audit_events", "operation_id")
