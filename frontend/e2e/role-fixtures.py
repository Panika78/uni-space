"""Disposable role E2E fixtures/permission changes; isolated local test DB only."""

import sys

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    Teacher,
    User,
)
from app.permissions import ACADEMIC_PERMISSIONS, PermissionCode

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
            ("student-reader", "staff"),
            ("status-only", "staff"),
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
                    permission_code = {
                        "reviewer": "applications.review",
                        "editor": "schedule.edit",
                        "student-reader": PermissionCode.STUDENTS_READ.value,
                        "status-only": PermissionCode.STUDENTS_STATUS_EDIT.value,
                    }[name]
                    db.add(
                        StaffPermission(
                            staff_profile_id=profile.id,
                            permission_code=permission_code,
                            scope_org_unit_id=org.id if name == "reviewer" else None,
                        )
                    )
        faculty = db.scalar(
            select(OrgUnit).where(OrgUnit.name == "Факультет Role E2E", OrgUnit.type == "faculty")
        )
        if not faculty:
            faculty = OrgUnit(name="Факультет Role E2E", type="faculty")
            db.add(faculty)
            db.flush()
        program = db.scalar(select(Program).where(Program.code == "ROLE-E2E"))
        if not program:
            program = Program(
                code="ROLE-E2E",
                name="Программа Role E2E",
                direction_code="E2E",
                direction_name="Направление Role E2E",
                faculty_id=faculty.id,
            )
            db.add(program)
            db.flush()
        group = db.scalar(select(StudyGroup).where(StudyGroup.name == "E2E-27"))
        if not group:
            group = StudyGroup(name="E2E-27", program_id=program.id, course_number=2)
            db.add(group)
            db.flush()
        student_user = db.scalar(select(User).where(User.login == "role-e2e-student"))
        if not student_user:
            student_user = User(
                login="role-e2e-student",
                password_hash=PASSWORD_HASHER.hash("unused"),
                full_name="Ёжова Елена E2E",
                role="student",
                is_active=True,
            )
            db.add(student_user)
            db.flush()
            db.add(Student(user_id=student_user.id, group_id=group.id, academic_status="enrolled"))
        else:
            student = db.scalar(select(Student).where(Student.user_id == student_user.id))
            student.group_id = group.id
            student.academic_status = "enrolled"
        for name, permission_code in (
            ("student-reader", PermissionCode.STUDENTS_READ.value),
            ("status-only", PermissionCode.STUDENTS_STATUS_EDIT.value),
        ):
            profile = db.scalar(
                select(StaffProfile)
                .join(User, User.id == StaffProfile.user_id)
                .where(User.login == f"role-e2e-{name}")
            )
            if profile:
                db.execute(
                    delete(StaffPermission).where(StaffPermission.staff_profile_id == profile.id)
                )
                db.add(
                    StaffPermission(
                        staff_profile_id=profile.id,
                        permission_code=permission_code,
                        scope_org_unit_id=None,
                    )
                )
    elif mode in ("review", "edit", "revoke", "revoke-students-read"):
        login = "role-e2e-student-reader" if mode == "revoke-students-read" else "role-e2e-reviewer"
        profile = db.scalar(
            select(StaffProfile)
            .join(User, User.id == StaffProfile.user_id)
            .where(User.login == login)
        )
        if not profile:
            raise SystemExit("Seed role fixtures first")
        db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile.id))
        if mode not in ("revoke", "revoke-students-read"):
            db.add(
                StaffPermission(
                    staff_profile_id=profile.id,
                    permission_code="applications.review" if mode == "review" else "schedule.edit",
                    scope_org_unit_id=profile.org_unit_id if mode == "review" else None,
                )
            )
    elif mode == "student-id":
        student = db.scalar(
            select(Student)
            .join(User, User.id == Student.user_id)
            .where(User.login == "role-e2e-student")
        )
        if not student:
            raise SystemExit("Seed role fixtures first")
        print(student.id)
    else:
        raise SystemExit("Unknown fixture command")
