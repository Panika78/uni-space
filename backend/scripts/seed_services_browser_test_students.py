"""Create two disposable student accounts for the services browser E2E."""

from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import AcademicTerm, OrgUnit, Program, ServiceType, Student, StudyGroup, User


def main() -> None:
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if settings.app_env != "test" or url.database != "uni_space_test":
        raise SystemExit("Refusing to seed browser E2E accounts outside uni_space_test")

    suffix = uuid4().hex
    password = "Fictional-Services-E2E-Password-2026"
    with SessionLocal.begin() as session:
        faculty = OrgUnit(name=f"Browser E2E faculty {suffix}", type="faculty")
        session.add(faculty)
        session.flush()
        session.add(
            OrgUnit(name=f"Browser E2E dean {suffix}", type="dean_office", parent_id=faculty.id)
        )
        accounting = OrgUnit(name=f"Browser E2E accounting {suffix}", type="accounting")
        session.add(accounting)
        today = datetime.now(ZoneInfo("Europe/Moscow")).date()
        active_terms = session.scalars(
            select(AcademicTerm).where(
                AcademicTerm.starts_on <= today, AcademicTerm.ends_on >= today
            )
        ).all()
        if not active_terms:
            session.add(
                AcademicTerm(
                    name=f"Browser E2E term {suffix}",
                    starts_on=today - timedelta(days=30),
                    ends_on=today + timedelta(days=180),
                )
            )
        session.flush()
        accounting_service = session.scalar(
            select(ServiceType).where(ServiceType.code == "accounting_certificate")
        )
        if accounting_service is None:
            raise RuntimeError("Run Alembic migrations before seeding browser students")
        accounting_service.responsible_org_unit_id = accounting.id
        program = Program(
            code=suffix,
            name="Browser E2E program",
            direction_code=suffix,
            direction_name="Browser E2E",
            faculty_id=faculty.id,
        )
        session.add(program)
        session.flush()
        group = StudyGroup(name=f"E2E-{suffix}", program_id=program.id, course_number=1)
        session.add(group)
        users = [
            User(
                login=f"services-e2e-{suffix}-{letter}",
                password_hash=PASSWORD_HASHER.hash(password),
                full_name=f"Fictional Services E2E Student {letter.upper()}",
                role="student",
                is_active=True,
            )
            for letter in ("a", "b")
        ]
        session.add_all([group, *users])
        session.flush()
        session.add_all(
            [
                Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
                for user in users
            ]
        )

    print(f"SERVICES_TEST_LOGIN={users[0].login}")
    print(f"SERVICES_TEST_LOGIN_B={users[1].login}")
    print(f"SERVICES_TEST_PASSWORD={password}")


if __name__ == "__main__":
    main()
