"""Serialize schedule and assessment-date writes; preserve group references.

Forward-only repair. The already merged 20261112_02 and 20261114_03 stay frozen.
Revision ID: 20261116_04
Revises: 20261116_03
"""

from alembic import op

revision = "20261116_04"
down_revision = "20261116_03"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
LOCK TABLE lessons, lesson_groups, assessment_groups IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION validate_editor_lesson_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE offering bigint;
BEGIN
    UPDATE lessons SET version=version WHERE id=NEW.lesson_id
      RETURNING course_offering_id INTO offering;
    PERFORM 1 FROM course_groups
      WHERE course_offering_id=offering AND group_id=NEW.group_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lesson group must study the offering' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_editor_lesson_group BEFORE INSERT OR UPDATE ON lesson_groups
FOR EACH ROW EXECUTE FUNCTION validate_editor_lesson_group();

CREATE FUNCTION validate_assessment_date_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE current_status text;
BEGIN
    -- The existing validate_assessment_assignment trigger also writes this
    -- parent row. Repeat the lock here so trigger ordering is immaterial.
    -- Actual writes reject stale RR snapshots, unlike a row lock alone.
    IF NEW.lesson_id IS NOT NULL AND NOT NEW.date_needs_confirmation THEN
        IF TG_OP='UPDATE' AND NEW.lesson_id IS NOT DISTINCT FROM OLD.lesson_id
          AND NEW.planned_date IS NOT DISTINCT FROM OLD.planned_date
          AND NEW.date_needs_confirmation IS NOT DISTINCT FROM OLD.date_needs_confirmation
          AND NEW.group_id=OLD.group_id AND NEW.assessment_id=OLD.assessment_id
          THEN RETURN NEW; END IF;
        UPDATE lessons SET version=version WHERE id=NEW.lesson_id
          RETURNING status INTO current_status;
        IF current_status IS DISTINCT FROM 'scheduled' THEN
            RAISE EXCEPTION 'Cannot confirm a cancelled or moved lesson'
              USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_assessment_date_confirmation BEFORE INSERT OR UPDATE ON assessment_groups
FOR EACH ROW EXECUTE FUNCTION validate_assessment_date_confirmation();
REVOKE ALL ON FUNCTION validate_editor_lesson_group() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_assessment_date_confirmation() FROM PUBLIC;
UPDATE lessons SET version=version;
""")


def downgrade():
    # No business data is changed or discarded by rollback. Existing #62
    # assignment-preservation guards remain installed.
    op.execute("""
DROP TRIGGER validate_assessment_date_confirmation ON assessment_groups;
DROP FUNCTION validate_assessment_date_confirmation();
DROP TRIGGER validate_editor_lesson_group ON lesson_groups;
DROP FUNCTION validate_editor_lesson_group();
""")
