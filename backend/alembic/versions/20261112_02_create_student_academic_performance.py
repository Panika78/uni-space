"""Create student academic performance

Revision ID: 20261112_02
Revises: 20261112_01
Create Date: 2026-11-11 21:44:17.258049
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261112_02"
down_revision: str | Sequence[str] | None = "20261112_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "assessments",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("course_offering_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("max_score", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("created_by_user_id", sa.BigInteger(), nullable=True),
        sa.CheckConstraint("max_score >= 0", name="ck_assessments_max_score"),
        sa.ForeignKeyConstraint(
            ["course_offering_id"],
            ["course_offerings.id"],
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_assessments_course_offering_id", "assessments", ["course_offering_id"], unique=False
    )
    op.create_table(
        "assessment_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("assessment_id", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.Column("planned_date", sa.Date(), nullable=True),
        sa.Column("lesson_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "date_needs_confirmation", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["assessment_id"],
            ["assessments.id"],
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["study_groups.id"],
        ),
        sa.ForeignKeyConstraint(
            ["lesson_id"],
            ["lessons.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "assessment_id", "group_id", name="uq_assessment_groups_assessment_group"
        ),
    )
    op.create_index(
        "ix_assessment_groups_group_date",
        "assessment_groups",
        ["group_id", "planned_date"],
        unique=False,
    )
    op.create_table(
        "assessment_results",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("assessment_group_id", sa.BigInteger(), nullable=False),
        sa.Column("student_id", sa.BigInteger(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("graded_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column("graded_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("score >= 0", name="ck_assessment_results_score"),
        sa.ForeignKeyConstraint(
            ["assessment_group_id"],
            ["assessment_groups.id"],
        ),
        sa.ForeignKeyConstraint(
            ["graded_by_user_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["student_id"],
            ["students.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "assessment_group_id", "student_id", name="uq_assessment_results_assignment_student"
        ),
    )
    op.create_index(
        "ix_assessment_results_student_assignment",
        "assessment_results",
        ["student_id", "assessment_group_id"],
        unique=False,
    )
    op.create_table(
        "final_results",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("course_offering_id", sa.BigInteger(), nullable=False),
        sa.Column("student_id", sa.BigInteger(), nullable=False),
        sa.Column("grade_value", sa.Integer(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column("retake_date", sa.Date(), nullable=True),
        sa.Column("retake_location", sa.String(), nullable=True),
        sa.CheckConstraint(
            "grade_value IS NOT NULL OR passed IS NOT NULL "
            "OR retake_date IS NOT NULL OR retake_location IS NOT NULL",
            name="ck_final_results_not_empty",
        ),
        sa.CheckConstraint(
            "grade_value IS NULL OR grade_value BETWEEN 2 AND 5", name="ck_final_results_grade"
        ),
        sa.CheckConstraint(
            "grade_value IS NULL OR passed IS NULL", name="ck_final_results_single_kind"
        ),
        sa.ForeignKeyConstraint(
            ["course_offering_id"],
            ["course_offerings.id"],
        ),
        sa.ForeignKeyConstraint(
            ["student_id"],
            ["students.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "course_offering_id", "student_id", name="uq_final_results_offering_student"
        ),
    )
    op.create_index(
        "ix_final_results_student_offering",
        "final_results",
        ["student_id", "course_offering_id"],
        unique=False,
    )
    # Cross-table rules cannot be expressed as PostgreSQL CHECK constraints.
    # Parent row locks coordinate changes with the reverse guards below.
    op.execute("""
CREATE FUNCTION validate_assessment_assignment() RETURNS trigger
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
CREATE TRIGGER validate_assessment_assignment BEFORE INSERT OR UPDATE ON assessment_groups
FOR EACH ROW EXECUTE FUNCTION validate_assessment_assignment();

CREATE FUNCTION preserve_assessment_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_TABLE_NAME='assessments' THEN
        IF EXISTS (SELECT 1 FROM assessment_groups g WHERE g.assessment_id=OLD.id
          AND NOT EXISTS (SELECT 1 FROM course_groups c
            WHERE c.course_offering_id=NEW.course_offering_id AND c.group_id=g.group_id))
          OR EXISTS (SELECT 1 FROM assessment_groups g JOIN lessons l ON l.id=g.lesson_id
            WHERE g.assessment_id=OLD.id AND l.course_offering_id<>NEW.course_offering_id) THEN
            RAISE EXCEPTION 'Assessment change invalidates assignments' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME='course_groups' THEN
        IF TG_OP='UPDATE' AND NEW.course_offering_id=OLD.course_offering_id
          AND NEW.group_id=OLD.group_id THEN RETURN NEW; END IF;
        IF EXISTS (SELECT 1 FROM assessment_groups g JOIN assessments a ON a.id=g.assessment_id
          WHERE a.course_offering_id=OLD.course_offering_id AND g.group_id=OLD.group_id) THEN
            RAISE EXCEPTION 'Course group is used by an assignment' USING ERRCODE='23514';
        END IF;
    ELSIF TG_TABLE_NAME='lessons' THEN
        IF EXISTS (SELECT 1 FROM assessment_groups g JOIN assessments a ON a.id=g.assessment_id
          WHERE g.lesson_id=OLD.id AND a.course_offering_id<>NEW.course_offering_id) THEN
            RAISE EXCEPTION 'Lesson change invalidates assignments' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME='lesson_groups' THEN
        IF TG_OP='UPDATE' AND NEW.lesson_id=OLD.lesson_id AND NEW.group_id=OLD.group_id
          THEN RETURN NEW; END IF;
        IF EXISTS (SELECT 1 FROM assessment_groups g
          WHERE g.lesson_id=OLD.lesson_id AND g.group_id=OLD.group_id) THEN
            RAISE EXCEPTION 'Lesson group is used by an assignment' USING ERRCODE='23514';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER preserve_assessment_assignment BEFORE UPDATE ON assessments
FOR EACH ROW EXECUTE FUNCTION preserve_assessment_assignment();
CREATE TRIGGER preserve_course_group_assignment BEFORE UPDATE OR DELETE ON course_groups
FOR EACH ROW EXECUTE FUNCTION preserve_assessment_assignment();
CREATE TRIGGER preserve_lesson_assignment BEFORE UPDATE ON lessons
FOR EACH ROW EXECUTE FUNCTION preserve_assessment_assignment();
CREATE TRIGGER preserve_lesson_group_assignment BEFORE UPDATE OR DELETE ON lesson_groups
FOR EACH ROW EXECUTE FUNCTION preserve_assessment_assignment();

CREATE FUNCTION validate_assessment_result() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE maximum integer; assigned_group bigint; current_group bigint;
BEGIN
    SELECT a.max_score, g.group_id INTO maximum, assigned_group
      FROM assessments a JOIN assessment_groups g ON g.assessment_id=a.id
      WHERE g.id=NEW.assessment_group_id FOR SHARE OF a, g;
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
CREATE TRIGGER validate_assessment_result BEFORE INSERT OR UPDATE ON assessment_results
FOR EACH ROW EXECUTE FUNCTION validate_assessment_result();

CREATE FUNCTION validate_final_result_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE kind text;
BEGIN
    SELECT attestation_type INTO kind FROM course_offerings
      WHERE id=NEW.course_offering_id FOR SHARE;
    IF (kind='pass_fail' AND NEW.grade_value IS NOT NULL)
       OR (kind IN ('exam','graded_pass') AND NEW.passed IS NOT NULL) THEN
        RAISE EXCEPTION 'Final result does not match attestation type' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_final_result_type BEFORE INSERT OR UPDATE ON final_results
FOR EACH ROW EXECUTE FUNCTION validate_final_result_type();
CREATE FUNCTION preserve_final_result_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM final_results r WHERE r.course_offering_id=OLD.id
      AND ((NEW.attestation_type='pass_fail' AND r.grade_value IS NOT NULL)
        OR (NEW.attestation_type IN ('exam','graded_pass') AND r.passed IS NOT NULL))) THEN
        RAISE EXCEPTION 'Attestation change invalidates final results' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER preserve_final_result_type BEFORE UPDATE ON course_offerings
FOR EACH ROW EXECUTE FUNCTION preserve_final_result_type();
""")


def downgrade() -> None:
    op.execute("""
DROP TRIGGER validate_assessment_result ON assessment_results;
DROP FUNCTION validate_assessment_result();
DROP TRIGGER preserve_final_result_type ON course_offerings;
DROP TRIGGER validate_final_result_type ON final_results;
DROP FUNCTION preserve_final_result_type();
DROP FUNCTION validate_final_result_type();
DROP TRIGGER preserve_lesson_group_assignment ON lesson_groups;
DROP TRIGGER preserve_lesson_assignment ON lessons;
DROP TRIGGER preserve_course_group_assignment ON course_groups;
DROP TRIGGER preserve_assessment_assignment ON assessments;
DROP FUNCTION preserve_assessment_assignment();
DROP TRIGGER validate_assessment_assignment ON assessment_groups;
DROP FUNCTION validate_assessment_assignment();
""")
    op.drop_index("ix_final_results_student_offering", table_name="final_results")
    op.drop_table("final_results")
    op.drop_index("ix_assessment_results_student_assignment", table_name="assessment_results")
    op.drop_table("assessment_results")
    op.drop_index("ix_assessment_groups_group_date", table_name="assessment_groups")
    op.drop_table("assessment_groups")
    op.drop_index("ix_assessments_course_offering_id", table_name="assessments")
    op.drop_table("assessments")
