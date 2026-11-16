"""Run assignment consistency locks under the migration owner.

Revision ID: 20261116_01
Revises: 20261115_03
"""

from alembic import op

revision = "20261116_01"
down_revision = "20261115_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # validate_assessment_result performs a no-op UPDATE on assessment_groups
    # to serialize score writes with assignment edits. That fires
    # validate_assessment_assignment, whose SELECT FOR SHARE also locks
    # lesson_groups. Running this trigger function as its migration owner keeps
    # the runtime role from needing UPDATE on lesson_groups merely to read-lock
    # it. The fixed search_path prevents object shadowing in a definer function.
    op.execute("""
CREATE OR REPLACE FUNCTION validate_assessment_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE offering bigint;
BEGIN
    SELECT course_offering_id INTO offering FROM assessments
      WHERE id=NEW.assessment_id FOR SHARE;
    PERFORM 1 FROM course_groups
      WHERE course_offering_id=offering AND group_id=NEW.group_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment group must study the assessment offering' USING ERRCODE='23514';
    END IF;
    IF NEW.lesson_id IS NOT NULL THEN
        PERFORM 1 FROM lessons l JOIN lesson_groups g ON g.lesson_id=l.id
          WHERE l.id=NEW.lesson_id AND l.course_offering_id=offering AND g.group_id=NEW.group_id
          FOR SHARE OF l, g;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assignment lesson must match offering and group' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_assessment_assignment() FROM PUBLIC;
""")


def downgrade() -> None:
    # Restore the invoker-security definition from 20261112_02 while retaining
    # the same assignment checks and row locks.
    op.execute("""
CREATE OR REPLACE FUNCTION validate_assessment_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE offering bigint;
BEGIN
    SELECT course_offering_id INTO offering FROM assessments
      WHERE id=NEW.assessment_id FOR SHARE;
    PERFORM 1 FROM course_groups
      WHERE course_offering_id=offering AND group_id=NEW.group_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment group must study the assessment offering' USING ERRCODE='23514';
    END IF;
    IF NEW.lesson_id IS NOT NULL THEN
        PERFORM 1 FROM lessons l JOIN lesson_groups g ON g.lesson_id=l.id
          WHERE l.id=NEW.lesson_id AND l.course_offering_id=offering AND g.group_id=NEW.group_id
          FOR SHARE OF l, g;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assignment lesson must match offering and group' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
""")
