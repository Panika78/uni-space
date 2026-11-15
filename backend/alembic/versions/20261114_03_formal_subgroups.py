"""Formal subgroups and NULL-aware lesson assignments.

Revision ID: 20261114_03
Revises: 20261114_02
"""

import sqlalchemy as sa

from alembic import op

revision = "20261114_03"
down_revision = "20261114_02"
branch_labels = None
depends_on = None


LEGACY_PRESERVE_ASSIGNMENT = """
CREATE OR REPLACE FUNCTION preserve_assessment_assignment() RETURNS trigger
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
"""

LEGACY_VALIDATE_ASSIGNMENT = """
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
"""

PRESERVE_ASSIGNMENT = """
CREATE OR REPLACE FUNCTION preserve_assessment_assignment() RETURNS trigger
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
        -- Touch the parent row even for direct SQL. A lock alone would allow
        -- write skew under a pre-existing REPEATABLE READ snapshot.
        UPDATE lessons SET version=version WHERE id=OLD.lesson_id;
        IF EXISTS (SELECT 1 FROM assessment_groups g
          WHERE g.lesson_id=OLD.lesson_id AND g.group_id=OLD.group_id)
          AND NOT EXISTS (SELECT 1 FROM lesson_groups g
            WHERE g.lesson_id=OLD.lesson_id AND g.group_id=OLD.group_id AND g.id<>OLD.id)
          THEN
            RAISE EXCEPTION 'Lesson group is used by an assignment' USING ERRCODE='23514';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
"""

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


def upgrade():
    op.create_table(
        "subgroups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_subgroups"),
        sa.UniqueConstraint("group_id", "id", name="uq_subgroups_group_id_id"),
        sa.ForeignKeyConstraint(
            ["group_id"], ["study_groups.id"], name="fk_subgroups_group_id_study_groups"
        ),
    )
    op.create_index("ix_subgroups_group_id", "subgroups", ["group_id"])
    for table in ("students", "lesson_groups"):
        op.add_column(table, sa.Column("subgroup_id", sa.BigInteger(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_group_subgroup",
            table,
            "subgroups",
            ["group_id", "subgroup_id"],
            ["group_id", "id"],
        )
    op.drop_constraint("uq_lesson_groups_lesson_group", "lesson_groups", type_="unique")
    op.create_index(
        "uq_lesson_groups_whole_group",
        "lesson_groups",
        ["lesson_id", "group_id"],
        unique=True,
        postgresql_where=sa.text("subgroup_id IS NULL"),
    )
    op.create_index(
        "uq_lesson_groups_subgroup",
        "lesson_groups",
        ["lesson_id", "group_id", "subgroup_id"],
        unique=True,
        postgresql_where=sa.text("subgroup_id IS NOT NULL"),
    )
    # Install the paired guards atomically. Invalidate snapshots that predate
    # installation without changing the public lesson version or any grades.
    op.execute(PRESERVE_ASSIGNMENT)
    op.execute(VALIDATE_ASSIGNMENT)
    op.execute("UPDATE lessons SET version=version")


def downgrade():
    # Never discard distribution data during rollback. Operators must explicitly
    # resolve memberships and remove subgroups before downgrading.
    op.execute("""
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subgroups) THEN
        RAISE EXCEPTION 'Cannot downgrade populated subgroups; resolve memberships first';
    END IF;
END $$;
""")
    op.execute(LEGACY_PRESERVE_ASSIGNMENT)
    op.execute(LEGACY_VALIDATE_ASSIGNMENT)
    op.create_unique_constraint(
        "uq_lesson_groups_lesson_group", "lesson_groups", ["lesson_id", "group_id"]
    )
    op.drop_index("uq_lesson_groups_subgroup", table_name="lesson_groups")
    op.drop_index("uq_lesson_groups_whole_group", table_name="lesson_groups")
    for table in ("lesson_groups", "students"):
        op.drop_constraint(f"fk_{table}_group_subgroup", table, type_="foreignkey")
        op.drop_column(table, "subgroup_id")
    op.drop_index("ix_subgroups_group_id", table_name="subgroups")
    op.drop_table("subgroups")
