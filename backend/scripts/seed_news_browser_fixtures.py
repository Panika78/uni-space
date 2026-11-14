"""Create isolated fictional student/news data for the dedicated browser E2E."""

import os
import stat
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import News, OrgUnit, Program, Student, StudyGroup, User


def main() -> None:
    output_mode = stat.S_IMODE(os.fstat(1).st_mode)
    if not stat.S_ISREG(os.fstat(1).st_mode) or output_mode != 0o600:
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
        raise SystemExit("Refusing to seed news browser data outside uni_space_test")

    with SessionLocal.begin() as session:
        if session.scalar(select(func.count()).select_from(News)) != 0:
            raise SystemExit("News browser fixtures require an empty news table")

        suffix = uuid4().hex
        faculty = OrgUnit(name=f"News E2E fictional faculty {suffix}", type="faculty")
        session.add(faculty)
        session.flush()
        program = Program(
            code=suffix,
            name="News E2E fictional program",
            direction_code=suffix,
            direction_name="News E2E fictional direction",
            faculty_id=faculty.id,
        )
        session.add(program)
        session.flush()
        group = StudyGroup(name=f"NEWS-E2E-{suffix}", program_id=program.id, course_number=1)
        login = f"news-e2e-{suffix}"
        password = "Fictional-News-E2E-Password-2026"
        user = User(
            login=login,
            password_hash=PASSWORD_HASHER.hash(password),
            full_name="Вымышленный студент теста новостей",
            role="student",
            is_active=True,
        )
        session.add_all([group, user])
        session.flush()
        session.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))

        published_at = datetime.now(UTC).replace(microsecond=0) - timedelta(days=90)
        news = []
        for index in range(70):
            title = (
                "ДлинныйЗаголовокБезПробеловДляПроверкиАдаптивнойПрокрутки"
                "НовостиВУниверситетскомКабинете" * 3
                if index == 0
                else f"Новости E2E: вымышленная публикация {index + 1:02d}"
            )
            news.append(
                News(
                    title=title,
                    body=(f"Вымышленное содержимое новости {index + 1}. " * 180),
                    author_user_id=None,
                    published_at=published_at - timedelta(minutes=index),
                    is_published=True,
                )
            )
        session.add_all(news)
        session.flush()
        detail_id = news[0].id

    print(f"NEWS_TEST_LOGIN={login}")
    print(f"NEWS_TEST_PASSWORD={password}")
    print(f"NEWS_TEST_DETAIL_ID={detail_id}")
    print(f"NEWS_TEST_DETAIL_TITLE={news[0].title}")


if __name__ == "__main__":
    main()
