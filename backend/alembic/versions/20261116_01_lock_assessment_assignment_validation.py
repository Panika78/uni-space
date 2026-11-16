"""Restore parent-row synchronization for lesson-bound assessments.

Revision ID: 20261116_01
Revises: 20261115_03
"""

from alembic import op

revision = "20261116_01"
down_revision = "20261115_03"
branch_labels = None
depends_on = None

VALIDATE_ASSIGNMENT = """
CREATE OR REPLACE FUNCTION validate_assessment_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE offering bigint; lesson_offering bigint;
BEGIN
    SELECT course_offering_id INTO offering FROM assessments
      WHERE id=NEW.assessment_id FOR SHARE;
    PERFORM 1 FROM course_groups
      WHERE course_offering_id=offering AND group_id=NEW.group_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment group must study the assessment offering' USING ERRCODE='23514';
    END IF;
    IF NEW.lesson_id IS NOT NULL THEN
        -- Same parent write as removal guards, before examining assignments.
        -- Do not SHARE-lock child rows: a direct DELETE already locks its child
        -- before running its trigger and may be waiting for this parent.
        UPDATE lessons SET version=version WHERE id=NEW.lesson_id
          RETURNING course_offering_id INTO lesson_offering;
        IF lesson_offering IS DISTINCT FROM offering OR NOT EXISTS (
          SELECT 1 FROM lesson_groups WHERE lesson_id=NEW.lesson_id AND group_id=NEW.group_id
        ) THEN
            RAISE EXCEPTION 'Assignment lesson must match offering and group' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
"""


def upgrade() -> None:
    # Keep this definition in sync with 20261114_03. That migration's paired
    # assignment/removal triggers serialize through the lesson parent row. A
    # child FOR SHARE here would both break that lock order and require an
    # unnecessary runtime UPDATE grant on lesson_groups.
    op.execute(VALIDATE_ASSIGNMENT)


def downgrade() -> None:
    # The immediately preceding revision (20261115_03) still uses the
    # parent-row synchronization introduced in 20261114_03.
    op.execute(VALIDATE_ASSIGNMENT)
