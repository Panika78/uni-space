"""Staff permission foundation and exclusive profile roles.

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
    op.create_unique_constraint("uq_users_id_role", "users", ["id", "role"])
    for table, role in [("students", "student"), ("teachers", "teacher")]:
        op.drop_constraint(f"fk_{table}_user_id_users", table, type_="foreignkey")
        op.add_column(
            table,
            sa.Column(
                "profile_role", sa.String(), nullable=False, server_default=sa.text(f"'{role}'")
            ),
        )
        op.create_check_constraint(f"ck_{table}_profile_role", table, f"profile_role = '{role}'")
        op.create_foreign_key(
            f"fk_{table}_user_role",
            table,
            "users",
            ["user_id", "profile_role"],
            ["id", "role"],
            deferrable=True,
            initially="DEFERRED",
        )
    op.create_table(
        "staff_profiles",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("profile_role", sa.String(), nullable=False, server_default=sa.text("'staff'")),
        sa.Column("org_unit_id", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_staff_profiles"),
        sa.UniqueConstraint("user_id", name="uq_staff_profiles_user_id"),
        sa.CheckConstraint("profile_role = 'staff'", name="ck_staff_profiles_profile_role"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_staff_profiles_user_id_users"),
        sa.ForeignKeyConstraint(
            ["user_id", "profile_role"],
            ["users.id", "users.role"],
            name="fk_staff_profiles_user_role",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["org_unit_id"], ["org_units.id"], name="fk_staff_profiles_org_unit_id_org_units"
        ),
    )
    op.create_index("ix_staff_profiles_org_unit_id", "staff_profiles", ["org_unit_id"])
    op.create_table(
        "staff_permissions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("staff_profile_id", sa.BigInteger(), nullable=False),
        sa.Column("permission_code", sa.String(), nullable=False),
        sa.Column("scope_org_unit_id", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_staff_permissions"),
        sa.ForeignKeyConstraint(
            ["staff_profile_id"],
            ["staff_profiles.id"],
            name="fk_staff_permissions_staff_profile_id_staff_profiles",
        ),
        sa.ForeignKeyConstraint(
            ["scope_org_unit_id"],
            ["org_units.id"],
            name="fk_staff_permissions_scope_org_unit_id_org_units",
        ),
        sa.CheckConstraint(
            "permission_code IN ('schedule.edit','grades.edit','attendance.edit',"
            "'students.read','students.edit','students.status.edit','groups.manage',"
            "'applications.review','news.publish')",
            name="ck_staff_permissions_code",
        ),
    )
    op.create_index(
        "uq_staff_permissions_scoped",
        "staff_permissions",
        ["staff_profile_id", "permission_code", "scope_org_unit_id"],
        unique=True,
        postgresql_where=sa.text("scope_org_unit_id IS NOT NULL"),
    )
    op.create_index(
        "uq_staff_permissions_unscoped",
        "staff_permissions",
        ["staff_profile_id", "permission_code"],
        unique=True,
        postgresql_where=sa.text("scope_org_unit_id IS NULL"),
    )
    op.create_index(
        "ix_staff_permissions_scope_org_unit_id", "staff_permissions", ["scope_org_unit_id"]
    )


def downgrade():
    op.drop_table("staff_permissions")
    op.drop_table("staff_profiles")
    for table in ["teachers", "students"]:
        op.drop_constraint(f"fk_{table}_user_role", table, type_="foreignkey")
        op.drop_constraint(f"ck_{table}_profile_role", table, type_="check")
        op.drop_column(table, "profile_role")
        op.create_foreign_key(f"fk_{table}_user_id_users", table, "users", ["user_id"], ["id"])
    op.drop_constraint("uq_users_id_role", "users", type_="unique")
