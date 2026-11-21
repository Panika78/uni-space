"""Repair initial membership dates created by the clock-based backfill."""

from alembic import op

revision = "20261121_01"
down_revision = "20261119_04"
branch_labels = None
depends_on = None


def upgrade():
    # 20261116_03 added membership_changed_at with clock_timestamp(), which
    # stamped existing students at migration time. Restore their actual
    # initial boundary from the associated user's creation timestamp. Version
    # > 0 means a tracked transfer occurred and its boundary must be preserved.
    op.execute("DROP TRIGGER track_student_membership ON students")
    op.execute("""
        UPDATE students s
        SET membership_changed_at = u.created_at
        FROM users u
        WHERE u.id = s.user_id
          AND s.membership_version = 0
          AND s.membership_changed_at > u.created_at
    """)
    op.execute("""
        CREATE TRIGGER track_student_membership BEFORE UPDATE ON students
        FOR EACH ROW EXECUTE FUNCTION track_student_membership()
    """)


def downgrade():
    # Reinstating artificial timestamps would reintroduce the attendance bug;
    # the restored creation timestamps are valid boundaries and are retained.
    pass
