"""Create two disposable student accounts for the services browser E2E."""

from uuid import uuid4

from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import OrgUnit, Program, Student, StudyGroup, User


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
