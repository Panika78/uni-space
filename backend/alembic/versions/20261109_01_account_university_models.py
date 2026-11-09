"""Create account and university reference tables.

Revision ID: 20261109_01
Revises:
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261109_01"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("login", sa.String(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("full_name", sa.String(), nullable=False),
        sa.Column("avatar_storage_key", sa.String(), nullable=True),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('student', 'teacher', 'staff', 'admin')",
            name="ck_users_role",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("login", name="uq_users_login"),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revocation_reason", sa.Text(), nullable=True),
        sa.CheckConstraint("expires_at > created_at", name="ck_auth_sessions_expiry"),
        sa.CheckConstraint(
            "last_used_at IS NULL OR last_used_at >= created_at",
            name="ck_auth_sessions_last_used_at",
        ),
        sa.CheckConstraint(
            "revoked_at IS NULL OR revoked_at >= created_at",
            name="ck_auth_sessions_revoked_at",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_auth_sessions_user_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_auth_sessions"),
    )
    op.create_index(
        "ix_auth_sessions_user_revoked_expires",
        "auth_sessions",
        ["user_id", "revoked_at", "expires_at"],
        unique=False,
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("session_id", sa.BigInteger(), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(length=32), nullable=False),
        sa.Column("parent_token_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("expires_at > created_at", name="ck_refresh_tokens_expiry"),
        sa.CheckConstraint(
            "octet_length(token_hash) = 32",
            name="ck_refresh_tokens_token_hash_sha256_length",
        ),
        sa.CheckConstraint(
            "parent_token_id IS NULL OR parent_token_id <> id",
            name="ck_refresh_tokens_parent_not_self",
        ),
        sa.CheckConstraint(
            "used_at IS NULL OR used_at >= created_at",
            name="ck_refresh_tokens_used_at",
        ),
        sa.CheckConstraint(
            "revoked_at IS NULL OR revoked_at >= created_at",
            name="ck_refresh_tokens_revoked_at",
        ),
        sa.ForeignKeyConstraint(
            ["parent_token_id"],
            ["refresh_tokens.id"],
            name="fk_refresh_tokens_parent_token_id_refresh_tokens",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"], ["auth_sessions.id"], name="fk_refresh_tokens_session_id_auth_sessions"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_tokens"),
        sa.UniqueConstraint("parent_token_id", name="uq_refresh_tokens_parent_token_id"),
        sa.UniqueConstraint("token_hash", name="uq_refresh_tokens_token_hash"),
    )
    op.create_index(
        "ix_refresh_tokens_session_created",
        "refresh_tokens",
        ["session_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "uq_refresh_tokens_one_active_per_session",
        "refresh_tokens",
        ["session_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )
    op.create_table(
        "org_units",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("parent_id", sa.BigInteger(), nullable=True),
        sa.CheckConstraint(
            "type IN ('faculty', 'department', 'dean_office', 'accounting')",
            name="ck_org_units_type",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["org_units.id"], name="fk_org_units_parent_id_org_units"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_org_units"),
    )
    op.create_index("ix_org_units_parent_id", "org_units", ["parent_id"], unique=False)
    op.create_table(
        "programs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("direction_code", sa.String(), nullable=False),
        sa.Column("direction_name", sa.String(), nullable=False),
        sa.Column("faculty_id", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["faculty_id"], ["org_units.id"], name="fk_programs_faculty_id_org_units"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_programs"),
    )
    op.create_index("ix_programs_faculty_id", "programs", ["faculty_id"], unique=False)
    op.create_table(
        "study_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("program_id", sa.BigInteger(), nullable=False),
        sa.Column("course_number", sa.Integer(), nullable=False),
        sa.CheckConstraint("course_number > 0", name="ck_study_groups_course_number"),
        sa.ForeignKeyConstraint(
            ["program_id"], ["programs.id"], name="fk_study_groups_program_id_programs"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_study_groups"),
    )
    op.create_index("ix_study_groups_program_id", "study_groups", ["program_id"], unique=False)
    op.create_table(
        "students",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.Column("academic_status", sa.String(), nullable=False),
        sa.CheckConstraint(
            "academic_status IN ('enrolled', 'academic_leave', 'expelled', 'graduated')",
            name="ck_students_academic_status",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["study_groups.id"], name="fk_students_group_id_study_groups"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_students_user_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_students"),
        sa.UniqueConstraint("user_id", name="uq_students_user_id"),
    )
    op.create_index("ix_students_group_id", "students", ["group_id"], unique=False)
    op.create_table(
        "teachers",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("full_name", sa.String(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("department_id", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(
            ["department_id"], ["org_units.id"], name="fk_teachers_department_id_org_units"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_teachers_user_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_teachers"),
        sa.UniqueConstraint("user_id", name="uq_teachers_user_id"),
    )
    op.create_index("ix_teachers_department_id", "teachers", ["department_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_teachers_department_id", table_name="teachers")
    op.drop_table("teachers")
    op.drop_index("ix_students_group_id", table_name="students")
    op.drop_table("students")
    op.drop_index("ix_study_groups_program_id", table_name="study_groups")
    op.drop_table("study_groups")
    op.drop_index("ix_programs_faculty_id", table_name="programs")
    op.drop_table("programs")
    op.drop_index("ix_org_units_parent_id", table_name="org_units")
    op.drop_table("org_units")
    op.drop_index("uq_refresh_tokens_one_active_per_session", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_session_created", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index("ix_auth_sessions_user_revoked_expires", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_table("users")
