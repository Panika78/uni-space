from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    PrimaryKeyConstraint,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class StaffProfile(Base):
    __tablename__ = "staff_profiles"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_staff_profiles"),
        UniqueConstraint("user_id", name="uq_staff_profiles_user_id"),
        CheckConstraint("profile_role = 'staff'", name="ck_staff_profiles_profile_role"),
        ForeignKeyConstraint(
            ["user_id", "profile_role"],
            ["users.id", "users.role"],
            name="fk_staff_profiles_user_role",
            deferrable=True,
            initially="DEFERRED",
        ),
        Index("ix_staff_profiles_org_unit_id", "org_unit_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", name="fk_staff_profiles_user_id_users")
    )
    profile_role: Mapped[str] = mapped_column(String, server_default=text("'staff'"))
    org_unit_id: Mapped[int] = mapped_column(
        ForeignKey("org_units.id", name="fk_staff_profiles_org_unit_id_org_units")
    )


class StaffPermission(Base):
    __tablename__ = "staff_permissions"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_staff_permissions"),
        CheckConstraint(
            "permission_code IN ('schedule.edit','grades.edit','attendance.edit',"
            "'students.read','students.edit','students.status.edit','groups.manage',"
            "'applications.review','news.publish')",
            name="ck_staff_permissions_code",
        ),
        Index(
            "uq_staff_permissions_scoped",
            "staff_profile_id",
            "permission_code",
            "scope_org_unit_id",
            unique=True,
            postgresql_where=text("scope_org_unit_id IS NOT NULL"),
        ),
        Index(
            "uq_staff_permissions_unscoped",
            "staff_profile_id",
            "permission_code",
            unique=True,
            postgresql_where=text("scope_org_unit_id IS NULL"),
        ),
        Index("ix_staff_permissions_scope_org_unit_id", "scope_org_unit_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    staff_profile_id: Mapped[int] = mapped_column(
        ForeignKey("staff_profiles.id", name="fk_staff_permissions_staff_profile_id_staff_profiles")
    )
    permission_code: Mapped[str] = mapped_column(String)
    scope_org_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_staff_permissions_scope_org_unit_id_org_units")
    )
