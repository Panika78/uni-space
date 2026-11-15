"""Protect reverse course membership and version direct child writes.

Revision ID: 20261115_05
Revises: 20261115_04
"""

from alembic import op

revision = "20261115_05"
down_revision = "20261115_04"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
LOCK TABLE lessons, lesson_groups, lesson_rooms, course_groups IN EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM lesson_groups g JOIN lessons l ON l.id=g.lesson_id
      WHERE NOT EXISTS (SELECT 1 FROM course_groups c
        WHERE c.course_offering_id=l.course_offering_id AND c.group_id=g.group_id)) THEN
        RAISE EXCEPTION 'Existing lesson group has no course membership; repair before upgrade'
          USING ERRCODE='23514';
    END IF;
END $$;
CREATE FUNCTION preserve_scheduled_course_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.course_offering_id=OLD.course_offering_id
      AND NEW.group_id=OLD.group_id THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM lesson_groups g JOIN lessons l ON l.id=g.lesson_id
        WHERE l.course_offering_id=OLD.course_offering_id AND g.group_id=OLD.group_id) THEN
        RAISE EXCEPTION 'Course group is used by a lesson' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER preserve_scheduled_course_group BEFORE UPDATE OR DELETE ON course_groups
FOR EACH ROW EXECUTE FUNCTION preserve_scheduled_course_group();

CREATE OR REPLACE FUNCTION validate_editor_lesson_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE offering bigint;
BEGIN
    UPDATE lessons SET version=version WHERE id=NEW.lesson_id
      RETURNING course_offering_id INTO offering;
    -- Write the course membership row to invalidate pre-existing RR snapshots
    -- of administrative deleters. NOWAIT avoids a cycle with #71's existing
    -- course-group SHARE -> lesson lock order. Roll back the whole operation.
    PERFORM 1 FROM course_groups
      WHERE course_offering_id=offering AND group_id=NEW.group_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lesson group must study the offering' USING ERRCODE='23514';
    END IF;
    UPDATE course_groups SET group_id=group_id
      WHERE course_offering_id=offering AND group_id=NEW.group_id;
    RETURN NEW;
END $$;

-- A parent offering change must not bypass the same membership invariant.
-- Deferred validation permits a service to replace participants in the same
-- transaction; validate the final state, never an intermediate assignment set.
CREATE FUNCTION validate_lesson_course_memberships() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE offering bigint; assigned_group bigint;
BEGIN
    SELECT course_offering_id INTO offering FROM lessons WHERE id=NEW.id;
    FOR assigned_group IN SELECT DISTINCT group_id FROM lesson_groups
        WHERE lesson_id=NEW.id ORDER BY group_id LOOP
        PERFORM 1 FROM course_groups WHERE course_offering_id=offering
          AND group_id=assigned_group FOR UPDATE NOWAIT;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Lesson group must study the offering' USING ERRCODE='23514';
        END IF;
        UPDATE course_groups SET group_id=group_id
          WHERE course_offering_id=offering AND group_id=assigned_group;
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER validate_lesson_course_memberships
AFTER UPDATE ON lessons DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.course_offering_id IS DISTINCT FROM NEW.course_offering_id)
EXECUTE FUNCTION validate_lesson_course_memberships();
REVOKE ALL ON FUNCTION validate_lesson_course_memberships() FROM PUBLIC;

CREATE FUNCTION version_lesson_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parents bigint[]; parent bigint;
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT array_agg(DISTINCT lesson_id ORDER BY lesson_id) INTO parents FROM new_links;
    ELSIF TG_OP='DELETE' THEN
        SELECT array_agg(DISTINCT lesson_id ORDER BY lesson_id) INTO parents FROM old_links;
    ELSE
        -- Semantic sets: an UPDATE id=id or tuple permutation does not change
        -- participants/rooms. Ignore the surrogate lesson_groups identifier.
        SELECT array_agg(DISTINCT (value->>'lesson_id')::bigint
                         ORDER BY (value->>'lesson_id')::bigint) INTO parents
        FROM (
          (SELECT to_jsonb(n)-'id' AS value FROM new_links n
           EXCEPT SELECT to_jsonb(o)-'id' FROM old_links o)
          UNION
          (SELECT to_jsonb(o)-'id' AS value FROM old_links o
           EXCEPT SELECT to_jsonb(n)-'id' FROM new_links n)
        ) changed;
    END IF;
    FOREACH parent IN ARRAY coalesce(parents, ARRAY[]::bigint[]) LOOP
        -- Child-first SQL must not deadlock with a service holding the parent.
        PERFORM 1 FROM lessons WHERE id=parent FOR UPDATE NOWAIT;
        UPDATE lessons SET version=version+1 WHERE id=parent;
    END LOOP;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION preserve_scheduled_course_group() FROM PUBLIC;
REVOKE ALL ON FUNCTION version_lesson_links() FROM PUBLIC;
""")
    for table in ("lesson_groups", "lesson_rooms"):
        for action in ("INSERT", "UPDATE", "DELETE"):
            references = {
                "INSERT": "NEW TABLE AS new_links",
                "DELETE": "OLD TABLE AS old_links",
                "UPDATE": "OLD TABLE AS old_links NEW TABLE AS new_links",
            }[action]
            op.execute(f"""
CREATE TRIGGER version_{table}_{action.lower()} AFTER {action} ON {table}
REFERENCING {references} FOR EACH STATEMENT EXECUTE FUNCTION version_lesson_links();
""")
    op.execute("UPDATE lessons SET version=version; UPDATE course_groups SET group_id=group_id")


def downgrade():
    for table in ("lesson_groups", "lesson_rooms"):
        for action in ("insert", "update", "delete"):
            op.execute(f"DROP TRIGGER version_{table}_{action} ON {table}")
    op.execute("""
DROP FUNCTION version_lesson_links();
DROP TRIGGER validate_lesson_course_memberships ON lessons;
DROP FUNCTION validate_lesson_course_memberships();
DROP TRIGGER preserve_scheduled_course_group ON course_groups;
DROP FUNCTION preserve_scheduled_course_group();
CREATE OR REPLACE FUNCTION validate_editor_lesson_group() RETURNS trigger
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
""")
