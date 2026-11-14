"""Formal subgroups and NULL-aware lesson assignments.

Revision ID: 20261114_01
Revises: 20261112_03
"""

import sqlalchemy as sa

from alembic import op

revision = "20261114_01"
down_revision = "20261112_03"
branch_labels = None
depends_on = None


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
