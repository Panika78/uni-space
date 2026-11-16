"""Isolated PostgreSQL setup and assertions for status/search browser regressions."""

import json
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AuditEvent,
    AuthSession,
    OrgUnit,
    Program,
    RefreshToken,
    Student,
    StudyGroup,
    User,
)

settings = get_settings()
url = make_url(settings.database_url.get_secret_value())
if (
    settings.app_env != "test"
    or url.host not in ("localhost", "127.0.0.1")
    or url.database != "uni_space_test"
    or url.username != "uni_space_test"
):
    raise SystemExit("Only isolated localhost uni_space_test is supported")
mode = sys.argv[1]
with SessionLocal.begin() as db:
    student = db.scalar(
        select(Student).join(User).where(User.login == "role-e2e-student")
    )
    if student is None:
        raise SystemExit("Seed role fixtures first")
    if mode == "prepare":
        db.execute(
            delete(AuditEvent).where(
                AuditEvent.entity_type == "student", AuditEvent.entity_id == student.id
            )
        )
        student.academic_status = "expelled"
        faculty = db.scalar(
            select(OrgUnit).where(OrgUnit.name == "Факультет Пагинация E2E")
        )
        if faculty is None:
            faculty = OrgUnit(name="Факультет Пагинация E2E", type="faculty")
            db.add(faculty)
            db.flush()
            program = Program(
                code="REVIEW27",
                name="Программа Пагинация E2E",
                direction_code="27",
                direction_name="Вымышленная",
                faculty_id=faculty.id,
            )
            db.add(program)
            db.flush()
            group = StudyGroup(name="ПАГ-27", program_id=program.id, course_number=2)
            db.add(group)
            db.flush()
            for number in range(45):
                user = User(
                    login=f"review27-page-{number}",
                    password_hash="unusable",
                    full_name=f"Ревью27 Студент {number:02}",
                    role="student",
                    is_active=True,
                )
                db.add(user)
                db.flush()
                db.add(
                    Student(
                        user_id=user.id, group_id=group.id, academic_status="enrolled"
                    )
                )
        session = db.scalar(
            select(AuthSession).where(AuthSession.user_id == student.user_id)
        )
        if session is None:
            expiry = datetime.now(UTC) + timedelta(days=1)
            session = AuthSession(user_id=student.user_id, expires_at=expiry)
            db.add(session)
            db.flush()
            db.add(
                RefreshToken(
                    session_id=session.id, token_hash=b"r" * 32, expires_at=expiry
                )
            )
    elif mode == "prepare-enrolled":
        db.execute(
            delete(AuditEvent).where(
                AuditEvent.entity_type == "student", AuditEvent.entity_id == student.id
            )
        )
        student.academic_status = "enrolled"
    elif mode.startswith("check:"):
        _, expected, count = mode.split(":")
        assert student.academic_status == expected
        events = db.scalars(
            select(AuditEvent)
            .where(
                AuditEvent.entity_type == "student", AuditEvent.entity_id == student.id
            )
            .order_by(AuditEvent.id)
        ).all()
        assert len(events) == int(count)
        assert events[-1].after_data == {"academic_status": expected}
        assert db.get(User, student.user_id).is_active
        assert db.get(StudyGroup, student.group_id).name == "E2E-27"
        assert all(
            session.revoked_at is None
            for session in db.scalars(
                select(AuthSession).where(AuthSession.user_id == student.user_id)
            )
        )
        assert all(
            token.revoked_at is None
            for token in db.scalars(
                select(RefreshToken)
                .join(AuthSession)
                .where(AuthSession.user_id == student.user_id)
            )
        )
        if int(count) == 5:
            assert [
                (
                    event.before_data["academic_status"],
                    event.after_data["academic_status"],
                )
                for event in events
            ] == [
                ("expelled", "academic_leave"),
                ("academic_leave", "expelled"),
                ("expelled", "enrolled"),
                ("enrolled", "graduated"),
                ("graduated", "academic_leave"),
            ]
            assert events[2].reason == "correction"
    elif mode == "ids":
        ids = db.scalars(
            select(Student.id)
            .join(User)
            .where(User.login.like("review27-page-%"))
            .order_by(User.full_name)
        ).all()
        print(json.dumps(ids))
    else:
        raise SystemExit("Unknown fixture mode")
