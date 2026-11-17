"""Create fictional account fixtures for the password-management browser E2E."""

import os
import stat
from uuid import uuid4

from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import OrgUnit, Program, StaffProfile, Student, StudyGroup, Teacher, User


def main() -> None:
    if not stat.S_ISREG(os.fstat(1).st_mode) or stat.S_IMODE(os.fstat(1).st_mode) != 0o600:
        raise SystemExit("Fixture credentials require a regular 0600 output file")
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "uni_space_test"
        or url.password != "test-only-password"
    ):
        raise SystemExit("Refusing to seed password browser data outside uni_space_test")

    suffix = uuid4().hex
    password = "Fictional-Password-E2E-Initial-2026"
    with SessionLocal.begin() as db:
        faculty = OrgUnit(name=f"Password E2E faculty {suffix}", type="faculty")
        department = OrgUnit(name=f"Password E2E department {suffix}", type="department")
        office = OrgUnit(name=f"Password E2E dean office {suffix}", type="dean_office")
        db.add_all([faculty, department, office])
        db.flush()
        program = Program(
            code=f"pw-{suffix}",
            name="Password E2E fictional program",
            direction_code="00.00.00",
            direction_name="Password E2E fictional direction",
            faculty_id=faculty.id,
        )
        db.add(program)
        db.flush()
        group = StudyGroup(name=f"PASSWORD-E2E-{suffix}", program_id=program.id, course_number=1)
        accounts = {
            role: User(
                login=f"password-{role}-{suffix}",
                password_hash=PASSWORD_HASHER.hash(password),
                full_name=f"Fictional Password E2E {role}",
                role=role,
                is_active=True,
            )
            for role in ("student", "teacher", "staff", "admin")
        }
        db.add_all([group, *accounts.values()])
        db.flush()
        student = Student(
            user_id=accounts["student"].id, group_id=group.id, academic_status="enrolled"
        )
        teacher = Teacher(
            user_id=accounts["teacher"].id,
            full_name=accounts["teacher"].full_name,
            department_id=department.id,
        )
        staff = StaffProfile(user_id=accounts["staff"].id, org_unit_id=office.id)
        db.add_all([student, teacher, staff])

    print(f"PASSWORD_E2E_SUFFIX={suffix}")
    print(f"PASSWORD_E2E_INITIAL_PASSWORD={password}")
    for role, user in accounts.items():
        print(f"PASSWORD_E2E_{role.upper()}_LOGIN={user.login}")
        print(f"PASSWORD_E2E_{role.upper()}_ID={user.id}")


if __name__ == "__main__":
    main()
