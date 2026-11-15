"""Disposable role E2E fixtures/permission changes; isolated local test DB only."""

import sys

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import OrgUnit, StaffPermission, StaffProfile, Teacher, User
from app.permissions import ACADEMIC_PERMISSIONS, PermissionCode
from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

settings = get_settings()
url = make_url(settings.database_url.get_secret_value())
if (
    settings.app_env != "test"
    or url.host not in ("localhost", "127.0.0.1")
    or url.database != "uni_space_test"
    or url.username != "uni_space_test"
):
    raise SystemExit("Only a disposable localhost uni_space_test database is supported")
mode = sys.argv[1] if len(sys.argv) > 1 else "seed"
with SessionLocal.begin() as db:
    if mode == "seed":
        org = db.scalar(
            select(OrgUnit).where(
                OrgUnit.name == "Вымышленный деканат Role E2E", OrgUnit.type == "dean_office"
            )
        )
        if not org:
            org = OrgUnit(name="Вымышленный деканат Role E2E", type="dean_office")
            db.add(org)
            db.flush()
        for name, role in [
            ("teacher", "teacher"),
            ("admin", "admin"),
            ("reviewer", "staff"),
            ("editor", "staff"),
            ("empty", "staff"),
            ("all", "staff"),
        ]:
            user = db.scalar(select(User).where(User.login == f"role-e2e-{name}"))
            if user:
                continue
            user = User(
                login=f"role-e2e-{name}",
                password_hash=PASSWORD_HASHER.hash("Fictional-Role-E2E-Password-2026"),
                full_name=f"Вымышленный пользователь {name}",
                role=role,
                is_active=True,
            )
            db.add(user)
            db.flush()
            if role == "teacher":
                db.add(Teacher(user_id=user.id, full_name=user.full_name))
            if role == "staff":
                profile = StaffProfile(user_id=user.id, org_unit_id=org.id)
                db.add(profile)
                db.flush()
                if name == "all":
                    for permission in PermissionCode:
                        db.add(
                            StaffPermission(
                                staff_profile_id=profile.id,
                                permission_code=permission.value,
                                scope_org_unit_id=None
                                if permission in ACADEMIC_PERMISSIONS
                                else org.id,
                            )
                        )
                elif name != "empty":
                    db.add(
                        StaffPermission(
                            staff_profile_id=profile.id,
                            permission_code="applications.review"
                            if name == "reviewer"
                            else "schedule.edit",
                            scope_org_unit_id=org.id if name == "reviewer" else None,
                        )
                    )
    elif mode in ("review", "edit", "revoke"):
        profile = db.scalar(
            select(StaffProfile)
            .join(User, User.id == StaffProfile.user_id)
            .where(User.login == "role-e2e-reviewer")
        )
        if not profile:
            raise SystemExit("Seed role fixtures first")
        db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile.id))
        if mode != "revoke":
            db.add(
                StaffPermission(
                    staff_profile_id=profile.id,
                    permission_code="applications.review" if mode == "review" else "schedule.edit",
                    scope_org_unit_id=profile.org_unit_id if mode == "review" else None,
                )
            )
    else:
        raise SystemExit("Unknown fixture command")
