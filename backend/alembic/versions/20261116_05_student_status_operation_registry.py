"""Store immutable status operation results outside the audit log.

Revision ID: 20261116_05
Revises: 20261115_04
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261116_05"
down_revision: str | Sequence[str] | None = "20261115_04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "student_status_operations",
        sa.Column("operation_id", sa.Uuid(as_uuid=False), nullable=False),
        sa.Column("actor_user_id", sa.BigInteger(), nullable=False),
        sa.Column("student_id", sa.BigInteger(), nullable=False),
        sa.Column("target_status", sa.String(), nullable=False),
        sa.Column("previous_status", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("changed", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.statement_timestamp(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "target_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_student_status_operations_target_status",
        ),
        sa.CheckConstraint(
            "previous_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_student_status_operations_previous_status",
        ),
        sa.CheckConstraint(
            "reason IN ('administrative_change', 'correction')",
            name="ck_student_status_operations_reason",
        ),
        sa.CheckConstraint(
            "changed = (previous_status <> target_status)",
            name="ck_student_status_operations_changed",
        ),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["student_id"], ["students.id"]),
        sa.PrimaryKeyConstraint("operation_id"),
    )
    # Preserve completed writes from the prior release. No-op writes were not
    # recorded by that implementation and cannot be inferred retroactively.
    op.execute(
        """INSERT INTO student_status_operations
           (operation_id, actor_user_id, student_id, target_status, previous_status,
            reason, changed, created_at)
           SELECT operation_id, actor_user_id, entity_id,
                  after_data->>'academic_status', before_data->>'academic_status',
                  reason, true, created_at
           FROM audit_events WHERE operation_id IS NOT NULL"""
    )
    op.drop_index("uq_audit_events_operation_id", table_name="audit_events")
    op.drop_constraint("ck_audit_events_status_operation_shape", "audit_events", type_="check")
    op.drop_constraint("ck_audit_events_status_operation_pair", "audit_events", type_="check")
    op.drop_column("audit_events", "operation_fingerprint")
    op.drop_column("audit_events", "operation_id")


def downgrade() -> None:
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
    op.drop_table("student_status_operations")
