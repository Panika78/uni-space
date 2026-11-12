"""Preserve recorded results when changing assignments and maxima.

Revision ID: 20261112_03
Revises: 20261112_02
"""

from alembic import op

revision = "20261112_03"
down_revision = "20261112_02"
branch_labels = None
depends_on = None

# Replaced in place so trigger ownership and ACL are retained on existing databases.
RESULT_VALIDATION = """
CREATE OR REPLACE FUNCTION validate_assessment_result() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE maximum integer; assigned_group bigint; current_group bigint;
        assessment bigint; locked_assessment bigint;
BEGIN
    SELECT assessment_id INTO assessment FROM assessment_groups
      WHERE id=NEW.assessment_group_id;
    -- Actual row versions, not only SHARE locks: a concurrent parent UPDATE
    -- must also detect a result committed after a REPEATABLE READ snapshot.
    -- Serialize result writers on the assessment before locking the assignment.
    UPDATE assessments SET max_score=max_score WHERE id=assessment
      RETURNING max_score INTO maximum;
    UPDATE assessment_groups SET id=id WHERE id=NEW.assessment_group_id
      RETURNING assessment_id, group_id INTO locked_assessment, assigned_group;
    IF locked_assessment IS DISTINCT FROM assessment THEN
        RAISE EXCEPTION 'Assessment assignment changed concurrently; retry transaction'
          USING ERRCODE='40001';
    END IF;
    IF NEW.score > maximum THEN
        RAISE EXCEPTION 'Score exceeds assessment maximum' USING ERRCODE='23514';
    END IF;
    -- A later student transfer preserves already recorded results.
    IF TG_OP='INSERT' OR NEW.student_id<>OLD.student_id
      OR NEW.assessment_group_id<>OLD.assessment_group_id THEN
        SELECT group_id INTO current_group FROM students WHERE id=NEW.student_id FOR SHARE;
        IF current_group<>assigned_group THEN
            RAISE EXCEPTION 'Student does not belong to assignment group' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
"""


def upgrade() -> None:
    # Do not silently rewrite personal grades if a previous version allowed bad data.
    op.execute("""
LOCK TABLE assessments, assessment_groups, assessment_results IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM assessment_results r
      JOIN assessment_groups g ON g.id=r.assessment_group_id
      JOIN assessments a ON a.id=g.assessment_id WHERE r.score>a.max_score) THEN
        RAISE EXCEPTION 'Existing assessment scores exceed maxima; repair before upgrading'
          USING ERRCODE='23514';
    END IF;
END $$;
CREATE FUNCTION preserve_graded_assessment_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF (NEW.group_id IS DISTINCT FROM OLD.group_id
        OR NEW.assessment_id IS DISTINCT FROM OLD.assessment_id)
      AND EXISTS (SELECT 1 FROM assessment_results WHERE assessment_group_id=OLD.id) THEN
        RAISE EXCEPTION 'Cannot reassign an assessment with recorded results' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER preserve_graded_assessment_assignment
BEFORE UPDATE OF group_id, assessment_id ON assessment_groups
FOR EACH ROW EXECUTE FUNCTION preserve_graded_assessment_assignment();
CREATE FUNCTION preserve_assessment_maximum() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM assessment_results r
      JOIN assessment_groups g ON g.id=r.assessment_group_id
      WHERE g.assessment_id=OLD.id AND r.score>NEW.max_score) THEN
        RAISE EXCEPTION 'Maximum is below a recorded score' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER preserve_assessment_maximum BEFORE UPDATE OF max_score ON assessments
FOR EACH ROW WHEN (OLD.max_score IS DISTINCT FROM NEW.max_score)
EXECUTE FUNCTION preserve_assessment_maximum();
""")
    op.execute(RESULT_VALIDATION)
    # Invalidate snapshots begun before installation: old result writers did not
    # touch parent row versions. Values (including personal grades) stay unchanged.
    op.execute("""
UPDATE assessments SET max_score=max_score;
UPDATE assessment_groups SET id=id;
""")
    # Match production default ACL even when this migration runs as a DB administrator.
    op.execute("""
REVOKE ALL ON FUNCTION preserve_graded_assessment_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION preserve_assessment_maximum() FROM PUBLIC;
""")


def downgrade() -> None:
    op.execute("""
DROP TRIGGER preserve_assessment_maximum ON assessments;
DROP FUNCTION preserve_assessment_maximum();
DROP TRIGGER preserve_graded_assessment_assignment ON assessment_groups;
DROP FUNCTION preserve_graded_assessment_assignment();
CREATE OR REPLACE FUNCTION validate_assessment_result() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE maximum integer; assigned_group bigint; current_group bigint;
BEGIN
    SELECT a.max_score, g.group_id INTO maximum, assigned_group
      FROM assessments a JOIN assessment_groups g ON g.assessment_id=a.id
      WHERE g.id=NEW.assessment_group_id FOR SHARE OF a, g;
    IF NEW.score > maximum THEN
        RAISE EXCEPTION 'Score exceeds assessment maximum' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' OR NEW.student_id<>OLD.student_id
      OR NEW.assessment_group_id<>OLD.assessment_group_id THEN
        SELECT group_id INTO current_group FROM students WHERE id=NEW.student_id FOR SHARE;
        IF current_group<>assigned_group THEN
            RAISE EXCEPTION 'Student does not belong to assignment group' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
""")
