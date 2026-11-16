"""Create two disposable student accounts for the services browser E2E."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Application,
    CourseGroup,
    CourseOffering,
    Discipline,
    OrgUnit,
    Program,
    ServiceType,
    Student,
    StudyGroup,
    User,
)


def main() -> None:
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if settings.app_env != "test" or url.database != "uni_space_test":
        raise SystemExit("Refusing to seed browser E2E accounts outside uni_space_test")

    suffix = "services-browser-e2e"
    password = "Fictional-Services-E2E-Password-2026"
    with SessionLocal.begin() as session:
        applications_before = session.scalar(select(func.count()).select_from(Application))
        faculty = session.scalar(
            select(OrgUnit).where(OrgUnit.name == f"Browser E2E faculty {suffix}")
        )
        if faculty is None:
            faculty = OrgUnit(name=f"Browser E2E faculty {suffix}", type="faculty")
            session.add(faculty)
            session.flush()
        dean = session.scalar(select(OrgUnit).where(OrgUnit.name == f"Browser E2E dean {suffix}"))
        if dean is None:
            session.add(
                OrgUnit(name=f"Browser E2E dean {suffix}", type="dean_office", parent_id=faculty.id)
            )
        accounting_units = session.scalars(
            select(OrgUnit).where(OrgUnit.type == "accounting")
        ).all()
        if not accounting_units:
            accounting = OrgUnit(name=f"Browser E2E accounting {suffix}", type="accounting")
            session.add(accounting)
            session.flush()
        elif len(accounting_units) == 1:
            accounting = accounting_units[0]
        else:
            raise RuntimeError("Browser E2E requires exactly one configured accounting unit")
        today = datetime.now(ZoneInfo("Europe/Moscow")).date()
        active_terms = session.scalars(
            select(AcademicTerm).where(
                AcademicTerm.starts_on <= today, AcademicTerm.ends_on >= today
            )
        ).all()
        if not active_terms:
            active_terms = [
                AcademicTerm(
                    name=f"Browser E2E term {suffix}",
                    starts_on=today - timedelta(days=30),
                    ends_on=today + timedelta(days=180),
                )
            ]
            session.add(active_terms[0])
        session.flush()
        accounting_service = session.scalar(
            select(ServiceType).where(ServiceType.code == "accounting_certificate")
        )
        if accounting_service is None:
            raise RuntimeError("Run Alembic migrations before seeding browser students")
        if accounting_service.responsible_org_unit_id is None:
            accounting_service.responsible_org_unit_id = accounting.id
        elif accounting_service.responsible_org_unit_id != accounting.id:
            raise RuntimeError("Accounting service already points to a different unit")
        program = Program(
            code=suffix,
            name="Browser E2E program",
            direction_code=suffix,
            direction_name="Browser E2E",
            faculty_id=faculty.id,
        )
        existing_program = session.scalar(select(Program).where(Program.code == suffix))
        if existing_program is None:
            session.add(program)
        else:
            program = existing_program
        session.flush()
        group = session.scalar(select(StudyGroup).where(StudyGroup.name == f"E2E-{suffix}"))
        if group is None:
            group = StudyGroup(name=f"E2E-{suffix}", program_id=program.id, course_number=1)
            session.add(group)
            session.flush()
        discipline = session.scalar(
            select(Discipline).where(Discipline.name == f"Browser E2E discipline {suffix}")
        )
        if discipline is None:
            discipline = Discipline(name=f"Browser E2E discipline {suffix}")
            session.add(discipline)
            session.flush()
        for term in active_terms:
            offering = session.scalar(
                select(CourseOffering).where(
                    CourseOffering.discipline_id == discipline.id, CourseOffering.term_id == term.id
                )
            )
            if offering is None:
                offering = CourseOffering(
                    discipline_id=discipline.id, term_id=term.id, attestation_type="exam"
                )
                session.add(offering)
                session.flush()
            if session.get(CourseGroup, (offering.id, group.id)) is None:
                session.add(CourseGroup(course_offering_id=offering.id, group_id=group.id))
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
        existing_users = [
            session.scalar(select(User).where(User.login == user.login)) for user in users
        ]
        users = [
            existing or candidate for existing, candidate in zip(existing_users, users, strict=True)
        ]
        session.add_all(
            [user for user, existing in zip(users, existing_users, strict=True) if existing is None]
        )
        session.flush()
        for user in users:
            student = session.scalar(select(Student).where(Student.user_id == user.id))
            if student is None:
                session.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))
        session.flush()
        applications_after = session.scalar(select(func.count()).select_from(Application))
        if applications_after != applications_before:
            raise RuntimeError("Seeding browser users must not modify application rows")

    print(f"SERVICES_TEST_LOGIN={users[0].login}")
    print(f"SERVICES_TEST_LOGIN_B={users[1].login}")
    print(f"SERVICES_TEST_PASSWORD={password}")


if __name__ == "__main__":
    main()
