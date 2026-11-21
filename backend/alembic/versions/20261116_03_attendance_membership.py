"""Preserve attendance origin and the current membership boundary, not a history."""

import sqlalchemy as sa

from alembic import op

revision = "20261116_03"
down_revision = "20261116_02"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "students",
        sa.Column("membership_version", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "students",
        sa.Column(
            "membership_changed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    # The column is introduced after historical lessons already exist. Using
    # clock_timestamp() as the ADD COLUMN default would make every existing
    # student appear to have joined today, incorrectly blocking old lessons.
    # users.created_at is the durable initial-membership boundary available in
    # this schema. New students still receive the current timestamp below.
    op.execute("""
        UPDATE students s
        SET membership_changed_at = u.created_at
        FROM users u
        WHERE u.id = s.user_id
    """)
    op.alter_column(
        "students",
        "membership_changed_at",
        nullable=False,
        server_default=sa.func.clock_timestamp(),
    )
    op.create_check_constraint(
        "ck_students_membership_version", "students", "membership_version >= 0"
    )
    # Database-owned metadata covers service, ORM and direct SQL transfers. The
    # row lock taken by UPDATE serializes this boundary with attendance writes.
    op.execute("""
        CREATE FUNCTION track_student_membership() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF (NEW.group_id, NEW.subgroup_id) IS DISTINCT FROM (OLD.group_id, OLD.subgroup_id) THEN
                NEW.membership_version := OLD.membership_version + 1;
                NEW.membership_changed_at := GREATEST(
                    clock_timestamp(), OLD.membership_changed_at + interval '1 microsecond'
                );
            ELSE
                NEW.membership_version := OLD.membership_version;
                NEW.membership_changed_at := OLD.membership_changed_at;
            END IF;
            RETURN NEW;
        END $$;
        CREATE TRIGGER track_student_membership BEFORE UPDATE ON students
        FOR EACH ROW EXECUTE FUNCTION track_student_membership();
    """)
    op.add_column("attendance", sa.Column("origin_group_id", sa.BigInteger()))
    op.add_column("attendance", sa.Column("origin_subgroup_id", sa.BigInteger()))
    op.add_column("attendance", sa.Column("membership_version", sa.BigInteger()))
    op.create_foreign_key(
        "fk_attendance_origin_group", "attendance", "study_groups", ["origin_group_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_attendance_origin_subgroup",
        "attendance",
        "subgroups",
        ["origin_group_id", "origin_subgroup_id"],
        ["group_id", "id"],
    )
    op.create_check_constraint(
        "ck_attendance_origin",
        "attendance",
        """
        (origin_group_id IS NULL AND origin_subgroup_id IS NULL AND membership_version IS NULL)
        OR (origin_group_id IS NOT NULL AND membership_version IS NOT NULL
            AND membership_version >= 0)
    """,
    )
    # Existing marks have no provable origin. Leave NULL instead of inferring it
    # from current membership or the last marker; only staff may correct these.


def downgrade():
    op.drop_constraint("ck_attendance_origin", "attendance")
    op.drop_constraint("fk_attendance_origin_subgroup", "attendance")
    op.drop_constraint("fk_attendance_origin_group", "attendance")
    for column in ("membership_version", "origin_subgroup_id", "origin_group_id"):
        op.drop_column("attendance", column)
    op.execute("DROP TRIGGER track_student_membership ON students")
    op.execute("DROP FUNCTION track_student_membership()")
    op.drop_constraint("ck_students_membership_version", "students")
    op.drop_column("students", "membership_changed_at")
    op.drop_column("students", "membership_version")
