"""Restore the initial roster boundary for verified fictional demo students."""

from alembic import op

revision = "20261122_01"
down_revision = "20261121_01"
branch_labels = None
depends_on = None


def upgrade():
    # The seed includes lessons from September, but older demo accounts were
    # inserted in November with clock_timestamp() as their initial boundary.
    # Only correct verifiable, never-transferred demo profiles. The trigger
    # protects membership metadata against ordinary UPDATEs, so temporarily
    # replace it inside the Alembic transaction.
    op.execute("DROP TRIGGER track_student_membership ON students")
    op.execute("""
        UPDATE students s
        SET membership_changed_at = TIMESTAMPTZ '2026-09-01 00:00:00+03'
        FROM users u, study_groups g, programs p
        WHERE s.user_id = u.id
          AND s.group_id = g.id
          AND g.program_id = p.id
          AND u.role = 'student'
          AND s.academic_status = 'enrolled'
          AND s.membership_version = 0
          AND s.membership_changed_at > TIMESTAMPTZ '2026-09-01 00:00:00+03'
          AND EXISTS (
              SELECT 1 FROM academic_terms t
              WHERE t.name = 'Осенний семестр 2026/2027'
                AND t.starts_on = DATE '2026-09-01'
                AND t.ends_on = DATE '2027-01-31'
          )
          AND (
              (u.login = 'demo-pz101'
               AND u.full_name IN ('Иван Сергеевич Гончаров', 'Артём Сергеевич Лавров')
               AND g.name = 'ПЗ-101' AND p.code = 'ПЗ')
              OR
              (u.login = 'demo-pm201'
               AND u.full_name = 'Амели Викторовна Волкова'
               AND g.name = 'ПМ-201' AND p.code = 'ПМ')
          )
    """)
    op.execute("""
        CREATE TRIGGER track_student_membership BEFORE UPDATE ON students
        FOR EACH ROW EXECUTE FUNCTION track_student_membership()
    """)


def downgrade():
    # Recreating invalid demo boundaries would disable legitimate past marks.
    # Retain the corrected historical boundary on downgrade.
    pass
