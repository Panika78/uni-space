"""Project grade audit events for the staff journal.

Revision ID: 20261118_01
Revises: 20261117_01
"""

from alembic import op

revision = "20261118_01"
down_revision = "20261117_01"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE INDEX ix_audit_events_journal_pair ON public.audit_events (
           entity_type,
           (CASE WHEN action = 'delete' THEN before_data ELSE after_data END ->
             CASE WHEN entity_type = 'assessment_result' THEN 'assessment_group_id'
                  ELSE 'course_offering_id' END),
           (CASE WHEN action = 'delete' THEN before_data ELSE after_data END -> 'student_id'),
           created_at DESC, id DESC
        )
        WHERE entity_type IN ('assessment_result', 'final_result')
          AND action IN ('create', 'update', 'delete')
    """)
    op.execute("""
        CREATE VIEW public.staff_journal_events AS
        SELECT id, action, entity_type, created_at, actor_user_id,
               snapshot -> target_field AS target_id,
               snapshot -> 'student_id' AS student_id,
               CASE WHEN action <> 'create' THEN
                 CASE entity_type WHEN 'assessment_result' THEN
                   jsonb_build_object('score', before_data -> 'score')
                 ELSE jsonb_build_object(
                   'grade_value', before_data -> 'grade_value',
                   'passed', before_data -> 'passed',
                   'retake_date', before_data -> 'retake_date',
                   'retake_location', before_data -> 'retake_location'
                 ) END
               END AS before,
               CASE WHEN action <> 'delete' THEN
                 CASE entity_type WHEN 'assessment_result' THEN
                   jsonb_build_object('score', after_data -> 'score')
                 ELSE jsonb_build_object(
                   'grade_value', after_data -> 'grade_value',
                   'passed', after_data -> 'passed',
                   'retake_date', after_data -> 'retake_date',
                   'retake_location', after_data -> 'retake_location'
                 ) END
               END AS after
        FROM public.audit_events
        CROSS JOIN LATERAL (
           SELECT CASE WHEN action = 'delete' THEN before_data ELSE after_data END AS snapshot,
                  CASE WHEN entity_type = 'assessment_result' THEN 'assessment_group_id'
                       ELSE 'course_offering_id' END AS target_field
        ) AS subject
        WHERE entity_type IN ('assessment_result', 'final_result')
          AND action IN ('create', 'update', 'delete')
          AND (action <> 'update' OR (
              before_data -> target_field = after_data -> target_field
              AND before_data -> 'student_id' = after_data -> 'student_id'
          ))
    """)


def downgrade():
    op.execute("DROP VIEW public.staff_journal_events")
    op.drop_index("ix_audit_events_journal_pair", table_name="audit_events")
