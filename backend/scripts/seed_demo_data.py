"""Explicitly seed the fictional MVP 1 demonstration university."""

from __future__ import annotations

import os
import socket
import sys
from datetime import UTC, date, datetime, time, timedelta
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Application,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    Attendance,
    AuditEvent,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    Lesson,
    LessonGroup,
    LessonRoom,
    News,
    Notification,
    OrgUnit,
    Program,
    Room,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    Subgroup,
    Teacher,
    TeacherAnnouncement,
    TeachingAssignment,
    User,
)

MOSCOW = ZoneInfo("Europe/Moscow")
TERM_START = date(2026, 9, 1)
TERM_END = date(2027, 1, 31)
DEMO_NEWS = (
    (
        "Об изменении расписания занятий 19 ноября в учебно-лабораторном корпусе",
        "В связи с внеплановой проверкой защитных контуров и обнаруженной "
        "нестабильностью магического фона в учебно-лабораторном корпусе 19 ноября "
        "возможны отмены и переносы отдельных занятий. Студентам и преподавателям "
        "рекомендуется заранее проверять актуальное расписание в личном кабинете. "
        "Информация об изменениях своевременно отображается в расписании конкретного студента.",
        datetime(2026, 11, 10, 9, tzinfo=MOSCOW),
    ),
    (
        "Подписывайтесь на официальный канал университета в MAX",
        "Университет готовит к запуску официальный информационный канал в MAX. "
        "Здесь будут публиковаться важные объявления, новости факультетов, "
        "информация об университетских мероприятиях, научных конференциях и "
        "событиях студенческой жизни. Ссылка на канал появится после его "
        "официального открытия. Следите за обновлениями!",
        datetime(2026, 11, 9, 10, tzinfo=MOSCOW),
    ),
    (
        "Приглашение Министерства Магии в мракоборцы",
        "Министерство Магии предлагает студентам всех курсов пройти службу в "
        "подразделение мракоборцев на добровольной основе. Приветствуются "
        "кандидаты, проявляющие особые способности в области защитной магии, "
        "распознавания тёмных чар и противодействия опасным магическим существам. "
        "Подробная информация о сроках и порядке отбора будет опубликована дополнительно.",
        datetime(2026, 11, 8, 10, tzinfo=MOSCOW),
    ),
)
LEGACY_INTRO_NEWS_BODY = (
    "19 ноября 2026 года в учебно-лабораторном корпусе проводится внеплановая "
    "проверка защитных контуров из-за нестабильного магического фона. "
    "Лабораторная работа по общей и неорганической химии отменена. "
    "Введение в зельеварение переносится на 20 ноября в Главный учебный "
    "корпус. Практикум по гадательным системам переносится с 19 на 21 "
    "ноября в Северную башню. Проверьте личное расписание: исходные занятия "
    "помечены как перенесённые или отменённые, новые позиции связаны с ними."
)
PREVIOUS_INTRO_NEWS_BODY = (
    "19 ноября 2026 года в учебно-лабораторном корпусе проводится внеплановая "
    "проверка оборудования. Лабораторная работа по общей и неорганической "
    "химии отменена. Введение в зельеварение сначала переносится на 20 ноября, "
    "затем на окончательную дату — 23 ноября 2026 года — в Главный "
    "учебный корпус. Практикум по гадательным системам переносится с 19 на 21 "
    "ноября в Северную башню. Проверьте личное расписание: исходные занятия "
    "помечены как перенесённые или отменённые, новые позиции связаны с ними."
)
MVP1_INTRO_NEWS_BODY = (
    "19 ноября 2026 года в учебно-лабораторном корпусе проводится внеплановая "
    "проверка защитных контуров из-за нестабильного магического фона. "
    "Лабораторная работа по общей и неорганической химии отменена. "
    "Введение в зельеварение сначала переносится на 20 ноября, затем на "
    "окончательную дату — 23 ноября 2026 года — в Главный учебный корпус. "
    "Практикум по гадательным системам переносится с 19 на 21 ноября в Северную "
    "башню. Проверьте личное расписание: исходные занятия помечены как "
    "перенесённые или отменённые, новые позиции связаны с ними."
)
LEGACY_DEMO_NEWS_BODIES = {
    "Подписывайтесь на официальный канал университета в MAX": (
        "Университет готовит официальный канал в MAX для новостей и объявлений. "
        "Адрес канала будет опубликован на этой странице после его подтверждения. "
        "Не используйте ссылки на неофициальные каналы."
    ),
    "Приглашение Министерства Магии в мракоборцы": (
        "Вымышленный отдел практик и трудоустройства публикует учебный пример "
        "объявления о стажировке. Министерство Магии и вакансия придуманы для "
        "демонстрации; у объявления нет действующих контактов или ссылки для отклика."
    ),
}

# This is the versioned identity of the demonstration deployment in
# compose.prod.yaml. It deliberately does not derive from POSTGRES_DB/DATABASE_URL.
PRODUCTION_DEMO_TARGET = ("db", 5432, "uni_space", "uni_space_migrator")


def expected_confirmation(target: tuple[str, int, str, str]) -> str:
    host, port, database, role = target
    return f"SEED_UNI_SPACE_DEMO_DATA:{database}@{host}:{port}/{role}"


def require_safe_target() -> None:
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    production_seed = (
        settings.app_env == "production" or os.getenv("DEMO_SEED_ALLOW_PRODUCTION") is not None
    )
    actual_port = url.port or 5432
    configured_target = (url.host or "", actual_port, url.database or "", url.username or "")
    if production_seed:
        if os.getenv("DEMO_SEED_ALLOW_PRODUCTION") != "YES_I_HAVE_A_BACKUP":
            raise RuntimeError(
                "Production seeding requires DEMO_SEED_ALLOW_PRODUCTION and a verified backup"
            )
        if configured_target != PRODUCTION_DEMO_TARGET:
            raise RuntimeError(
                "Production seed target does not match the pinned demonstration deployment"
            )
        expected_target = PRODUCTION_DEMO_TARGET
    elif url.username == "uni_space_migrator":
        raise RuntimeError("Migration role requires explicit production-seed confirmation")
    elif settings.app_env not in {"development", "test"}:
        raise RuntimeError("Seed is not permitted in this application environment")
    else:
        try:
            allowed_port = int(os.getenv("DEMO_SEED_ALLOWED_PORT", "0") or "0")
        except ValueError:
            raise RuntimeError("DEMO_SEED_ALLOWED_PORT must be a valid port") from None
        allowed_target = (
            os.getenv("DEMO_SEED_ALLOWED_HOST", ""),
            allowed_port,
            os.getenv("DEMO_SEED_ALLOWED_DATABASE", ""),
            os.getenv("DEMO_SEED_ALLOWED_ROLE", ""),
        )
        if not all(allowed_target) or configured_target != allowed_target:
            raise RuntimeError("Seed target must match all DEMO_SEED_ALLOWED_* values")
        expected_target = allowed_target
    if not url.database or "prod" in url.database.lower() and not production_seed:
        raise RuntimeError("Refusing a production-named database outside production mode")
    password_variables = (
        "DEMO_STUDENT_A_PASSWORD",
        "DEMO_STUDENT_B_PASSWORD",
        "DEMO_TEACHER_PASSWORD",
        "DEMO_DEAN_STAFF_PASSWORD",
        "DEMO_ACCOUNTING_STAFF_PASSWORD",
    )
    for variable in password_variables:
        password = os.getenv(variable, "")
        if len(password) < 12 or password != password.strip():
            raise RuntimeError(
                f"{variable} must be supplied externally and contain at least 12 characters"
            )
    if len({os.environ[name] for name in password_variables}) != len(password_variables):
        raise RuntimeError("Each demonstration account must have a different password")
    try:
        with SessionLocal() as session:
            database_name, database_user, server_address, server_port = session.execute(
                text(
                    "SELECT current_database(), current_user, host(inet_server_addr()), "
                    "inet_server_port()"
                )
            ).one()
            connection = session.connection().connection.driver_connection
            with socket.socket(fileno=os.dup(connection.pgconn.socket)) as database_socket:
                peer_address, peer_port = database_socket.getpeername()[:2]
    except Exception:
        raise RuntimeError("Could not verify the connected seed database target") from None
    try:
        resolved_addresses = {
            result[4][0]
            for result in socket.getaddrinfo(url.host, actual_port, type=socket.SOCK_STREAM)
        }
    except OSError:
        raise RuntimeError("Seed database host could not be resolved") from None
    safe_peer = f"{peer_address}:{peer_port}"
    safe_server = f"{server_address or 'unknown'}:{server_port or 'unknown'}"
    print(
        "Demo seed database target: "
        f"host={url.host} port={actual_port} database={database_name} "
        f"role={database_user} peer={safe_peer} server={safe_server}"
    )
    if (
        database_name != expected_target[2]
        or database_user == "uni_space_api"
        or database_user != url.username
        or peer_port != actual_port
        or peer_address not in resolved_addresses
    ):
        raise RuntimeError("Connected database, host, port, or role does not match the seed target")
    if production_seed:
        try:
            confirmation = input(
                "Type the pinned demonstration target confirmation "
                f"({expected_confirmation(PRODUCTION_DEMO_TARGET)}): "
            )
        except EOFError:
            confirmation = ""
    else:
        confirmation = os.getenv("DEMO_SEED_CONFIRM", "")
    if confirmation != expected_confirmation(expected_target):
        raise RuntimeError("Explicit confirmation of the expected seed target is required")


def one_or_create(session, model, identity: dict, values: dict, *, mutable: dict | None = None):
    matches = session.scalars(select(model).filter_by(**identity)).all()
    if len(matches) > 1:
        raise RuntimeError(f"Ambiguous existing {model.__tablename__} seed identity")
    instance = matches[0] if matches else model(**identity, **values)
    if matches:
        for key, value in values.items():
            current_value = getattr(instance, key)
            allowed_previous_values = (mutable or {}).get(key, set())
            if current_value != value and current_value not in allowed_previous_values:
                raise RuntimeError(
                    f"Existing {model.__tablename__} seed identity has unexpected data"
                )
            if current_value != value:
                setattr(instance, key, value)
    else:
        for key, value in values.items():
            setattr(instance, key, value)
    if not matches:
        session.add(instance)
    session.flush()
    return instance


def ensure_demo_user(
    session, login: str, full_name: str, role: str, password_variable: str
) -> User:
    existing = session.scalar(select(User).where(User.login == login))
    if existing and (existing.role != role or existing.full_name != full_name):
        raise RuntimeError(f"Existing demonstration account {login} has unexpected identity")
    password = os.environ[password_variable]
    if existing:
        try:
            password_matches = PASSWORD_HASHER.verify(existing.password_hash, password)
        except VerifyMismatchError:
            password_matches = False
        if not password_matches:
            raise RuntimeError(f"Supplied password does not match existing account {login}")
        return existing
    user = User(
        login=login,
        full_name=full_name,
        role=role,
        is_active=True,
        password_hash=PASSWORD_HASHER.hash(password),
    )
    session.add(user)
    session.flush()
    return user


def validate_active_schedule(session) -> None:
    """Reject overlapping active lessons by room, teacher, or student group."""
    lessons = session.scalars(
        select(Lesson).where(
            Lesson.status == "scheduled",
            Lesson.starts_at >= datetime.combine(TERM_START, time.min, MOSCOW),
            Lesson.starts_at < datetime.combine(TERM_END + timedelta(days=1), time.min, MOSCOW),
        )
    ).all()
    rooms_by_lesson: dict[int, set[int]] = {}
    groups_by_lesson: dict[int, set[tuple[int, int | None]]] = {}
    for lesson in lessons:
        rooms_by_lesson[lesson.id] = set(
            session.scalars(select(LessonRoom.room_id).where(LessonRoom.lesson_id == lesson.id))
        )
        groups_by_lesson[lesson.id] = set(
            session.execute(
                select(LessonGroup.group_id, LessonGroup.subgroup_id).where(
                    LessonGroup.lesson_id == lesson.id
                )
            ).tuples()
        )
    for index, left in enumerate(lessons):
        for right in lessons[index + 1 :]:
            if left.starts_at >= right.ends_at or right.starts_at >= left.ends_at:
                continue
            if (
                left.teacher_id == right.teacher_id
                or rooms_by_lesson[left.id] & rooms_by_lesson[right.id]
                or any(
                    left_group == right_group
                    and (
                        left_subgroup is None
                        or right_subgroup is None
                        or left_subgroup == right_subgroup
                    )
                    for left_group, left_subgroup in groups_by_lesson[left.id]
                    for right_group, right_subgroup in groups_by_lesson[right.id]
                )
            ):
                raise RuntimeError("Generated schedule contains an overlapping active lesson")


def clear_owned_legacy_lessons(session, group_ids: set[int], teacher_ids: set[int]) -> None:
    """Replace ordinary MVP1 lesson rows only when they have no user history."""
    lessons = session.scalars(
        select(Lesson)
        .join(LessonGroup, LessonGroup.lesson_id == Lesson.id)
        .where(
            LessonGroup.group_id.in_(group_ids),
            Lesson.status == "scheduled",
            Lesson.previous_lesson_id.is_(None),
            Lesson.starts_at >= datetime.combine(TERM_START, time.min, MOSCOW),
            Lesson.starts_at < datetime.combine(TERM_END + timedelta(days=1), time.min, MOSCOW),
        )
        .distinct()
    ).all()
    for lesson in lessons:
        groups = {
            (row.group_id, row.subgroup_id)
            for row in session.scalars(
                select(LessonGroup).where(LessonGroup.lesson_id == lesson.id)
            )
        }
        if (
            lesson.created_by_user_id is not None
            or lesson.teacher_id not in teacher_ids
            or not groups
            or any(
                group_id not in group_ids or subgroup_id is not None
                for group_id, subgroup_id in groups
            )
        ):
            raise RuntimeError("Cannot verify ownership of an existing lesson during MVP1 upgrade")
        has_protected_history = any(
            (
                session.scalar(
                    select(AssessmentGroup.id)
                    .where(AssessmentGroup.lesson_id == lesson.id)
                    .limit(1)
                ),
                session.scalar(
                    select(Attendance.lesson_id).where(Attendance.lesson_id == lesson.id).limit(1)
                ),
                session.scalar(
                    select(AuditEvent.id)
                    .where(AuditEvent.entity_type == "lesson", AuditEvent.entity_id == lesson.id)
                    .limit(1)
                ),
                session.scalar(
                    select(Notification.id)
                    .where(
                        Notification.entity_type == "lesson", Notification.entity_id == lesson.id
                    )
                    .limit(1)
                ),
                session.scalar(
                    select(Lesson.id).where(Lesson.previous_lesson_id == lesson.id).limit(1)
                ),
            )
        )
        if has_protected_history:
            raise RuntimeError("Existing lesson has linked user data; refusing to replace it")
        for relation in session.scalars(
            select(LessonRoom).where(LessonRoom.lesson_id == lesson.id)
        ):
            session.delete(relation)
        for relation in session.scalars(
            select(LessonGroup).where(LessonGroup.lesson_id == lesson.id)
        ):
            session.delete(relation)
        session.flush()
        session.delete(lesson)
    session.flush()


def remove_obsolete_legacy_course_groups(
    session, group_ids: set[int], desired_pairs: set[tuple[int, int]]
) -> None:
    for relation in session.scalars(
        select(CourseGroup).where(CourseGroup.group_id.in_(group_ids))
    ).all():
        if (relation.course_offering_id, relation.group_id) in desired_pairs:
            continue
        if session.scalar(
            select(TeachingAssignment.id)
            .where(
                TeachingAssignment.course_offering_id == relation.course_offering_id,
                TeachingAssignment.group_id == relation.group_id,
            )
            .limit(1)
        ):
            raise RuntimeError("Obsolete course has a teaching assignment; refusing cleanup")
        if session.scalar(
            select(AssessmentGroup.id)
            .where(AssessmentGroup.group_id == relation.group_id)
            .join(Assessment, Assessment.id == AssessmentGroup.assessment_id)
            .where(Assessment.course_offering_id == relation.course_offering_id)
            .limit(1)
        ):
            raise RuntimeError("Obsolete course has assessment history; refusing cleanup")
        stale_lesson = session.execute(
            select(Discipline.name, Lesson.id)
            .join(CourseOffering, CourseOffering.discipline_id == Discipline.id)
            .join(Lesson, Lesson.course_offering_id == CourseOffering.id)
            .join(LessonGroup, LessonGroup.lesson_id == Lesson.id)
            .where(
                Lesson.course_offering_id == relation.course_offering_id,
                LessonGroup.group_id == relation.group_id,
            )
            .limit(1)
        ).first()
        if stale_lesson:
            raise RuntimeError(
                f"Obsolete course {stale_lesson[0]} still has lesson history; refusing cleanup"
            )
        session.delete(relation)
    session.flush()


def require_seed_status(lesson: Lesson, accepted_statuses: set[str]) -> None:
    if lesson.status not in accepted_statuses:
        raise RuntimeError("Existing lesson status is not owned by the demonstration seed")


def require_lesson_relations(
    session,
    lesson: Lesson,
    expected_groups: set[tuple[int, int | None]],
    expected_rooms: set[int],
) -> None:
    actual_groups = set(
        session.execute(
            select(LessonGroup.group_id, LessonGroup.subgroup_id).where(
                LessonGroup.lesson_id == lesson.id
            )
        ).tuples()
    )
    if actual_groups != expected_groups:
        raise RuntimeError(
            "Seed lesson has unexpected lesson_groups relations "
            f"(lesson_id={lesson.id}, starts_at={lesson.starts_at.isoformat()})"
        )
    actual_rooms = set(
        session.scalars(select(LessonRoom.room_id).where(LessonRoom.lesson_id == lesson.id))
    )
    if actual_rooms != expected_rooms:
        raise RuntimeError(
            "Seed lesson has unexpected lesson_rooms relations "
            f"(lesson_id={lesson.id}, starts_at={lesson.starts_at.isoformat()})"
        )


def create_lesson_relations(
    session,
    lesson: Lesson,
    group_assignments: set[tuple[int, int | None]],
    room_ids: set[int],
) -> None:
    session.add_all(
        LessonGroup(lesson_id=lesson.id, group_id=group_id, subgroup_id=subgroup_id)
        for group_id, subgroup_id in group_assignments
    )
    session.add_all(LessonRoom(lesson_id=lesson.id, room_id=room_id) for room_id in room_ids)


def seed_demo_data() -> None:
    require_safe_target()
    with SessionLocal.begin() as db:
        demo_logins = ("demo-pz101", "demo-pm201")
        existing_demo_users = set(
            db.scalars(select(User.login).where(User.login.in_(demo_logins))).all()
        )
        legacy_mvp1_upgrade = (
            existing_demo_users == set(demo_logins)
            and db.scalar(select(Subgroup.id).limit(1)) is None
            and db.scalar(select(User.id).where(User.login == "demo-severin-voron").limit(1))
            is None
        )
        if existing_demo_users and existing_demo_users != set(demo_logins):
            raise RuntimeError(
                "Only one demonstration account exists; refusing partial data recovery"
            )
        if not existing_demo_users:
            existing_data = any(
                db.scalar(select(model).limit(1)) is not None
                for model in (
                    User,
                    Student,
                    OrgUnit,
                    Program,
                    StudyGroup,
                    AcademicTerm,
                    Discipline,
                    CourseOffering,
                    CourseGroup,
                    Assessment,
                    AssessmentGroup,
                    AssessmentResult,
                    FinalResult,
                    Application,
                    Teacher,
                    Building,
                    Room,
                    Lesson,
                    News,
                    Notification,
                )
            )
            if existing_data:
                raise RuntimeError(
                    "First seed requires a clean dedicated database after migrations"
                )
        faculty = one_or_create(
            db, OrgUnit, {"name": "Факультет естественных наук"}, {"type": "faculty"}
        )
        one_or_create(
            db,
            OrgUnit,
            {"name": "Деканат естественных наук"},
            {"type": "dean_office", "parent_id": faculty.id},
        )
        accounting = one_or_create(db, OrgUnit, {"name": "Бухгалтерия"}, {"type": "accounting"})
        departments = {
            name: one_or_create(
                db,
                OrgUnit,
                {"name": name},
                {"type": "department", "parent_id": faculty.id},
            )
            for name in (
                "Кафедра естественных наук",
                "Кафедра гуманитарных наук",
                "Кафедра прикладных дисциплин",
            )
        }
        programs = {
            "pz": one_or_create(
                db,
                Program,
                {"code": "ПЗ"},
                {
                    "name": "Прикладное зельеварение",
                    "direction_code": "MAG-01",
                    "direction_name": "Алхимия и технологии зельеварения",
                    "faculty_id": faculty.id,
                },
                mutable={
                    "direction_code": {"04.03.01", "MAG-01"},
                    "direction_name": {"Химия", "Алхимия и технологии зельеварения"},
                },
            ),
            "pm": one_or_create(
                db,
                Program,
                {"code": "ПМ"},
                {
                    "name": "Прикладная мантика и прогностика",
                    "direction_code": "MAG-02",
                    "direction_name": "Мантика и вероятностная магия",
                    "faculty_id": faculty.id,
                },
                mutable={
                    "direction_code": {"01.03.02", "MAG-02"},
                    "direction_name": {
                        "Прикладная математика и информатика",
                        "Мантика и вероятностная магия",
                    },
                },
            ),
        }
        groups = {
            key: one_or_create(
                db,
                StudyGroup,
                {"name": group_name},
                {"program_id": programs[key].id, "course_number": course},
            )
            for key, group_name, course in (("pz", "ПЗ-101", 1), ("pm", "ПМ-201", 2))
        }
        subgroups = {
            name: one_or_create(db, Subgroup, {"group_id": groups["pm"].id, "name": name}, {})
            for name in ("1-я подгруппа", "2-я подгруппа")
        }
        users = {}
        students = {}
        for key, login, full_name, password_var in (
            ("pz", "demo-pz101", "Иван Сергеевич Гончаров", "DEMO_STUDENT_A_PASSWORD"),
            ("pm", "demo-pm201", "Амели Викторовна Волкова", "DEMO_STUDENT_B_PASSWORD"),
        ):
            existing = db.scalar(select(User).where(User.login == login))
            legacy_name = "Артём Сергеевич Лавров" if key == "pz" else full_name
            if existing and existing.role != "student":
                raise RuntimeError(f"Refusing to take over existing account {login}")
            if existing and existing.full_name not in {full_name, legacy_name}:
                raise RuntimeError(f"Refusing to rename unverified account {login}")
            if existing:
                profile = db.scalar(select(Student).where(Student.user_id == existing.id))
                if profile is None:
                    raise RuntimeError(f"Cannot verify demonstration account ownership for {login}")
                expected_group = "ПЗ-101" if key == "pz" else "ПМ-201"
                expected_program = (
                    ("ПЗ", "Прикладное зельеварение", "MAG-01", "Алхимия и технологии зельеварения")
                    if key == "pz"
                    else (
                        "ПМ",
                        "Прикладная мантика и прогностика",
                        "MAG-02",
                        "Мантика и вероятностная магия",
                    )
                )
                group = db.get(StudyGroup, profile.group_id)
                program = db.get(Program, group.program_id) if group else None
                faculty = db.get(OrgUnit, program.faculty_id) if program else None
                if (
                    group is None
                    or group.name != expected_group
                    or group.course_number != (1 if key == "pz" else 2)
                    or profile.academic_status != "enrolled"
                    or program is None
                    or (
                        program.code,
                        program.name,
                        program.direction_code,
                        program.direction_name,
                    )
                    != expected_program
                    or faculty is None
                    or faculty.name != "Факультет естественных наук"
                    or faculty.type != "faculty"
                ):
                    raise RuntimeError(f"Cannot verify demonstration account ownership for {login}")
            password = os.environ[password_var]
            if existing:
                try:
                    password_matches = PASSWORD_HASHER.verify(existing.password_hash, password)
                except VerifyMismatchError:
                    password_matches = False
                if not password_matches:
                    raise RuntimeError(f"Supplied password does not match existing account {login}")
            password_hash = existing.password_hash if existing else PASSWORD_HASHER.hash(password)
            users[key] = one_or_create(
                db,
                User,
                {"login": login},
                {
                    "password_hash": password_hash,
                    "full_name": full_name,
                    "role": "student",
                    "is_active": existing.is_active if existing else True,
                },
                mutable={"full_name": {legacy_name, full_name}},
            )
            students[key] = one_or_create(
                db,
                Student,
                {"user_id": users[key].id},
                {
                    "group_id": groups[key].id,
                    "subgroup_id": subgroups["2-я подгруппа"].id if key == "pm" else None,
                    "academic_status": "enrolled",
                },
                mutable={
                    "subgroup_id": {None, subgroups["2-я подгруппа"].id} if key == "pm" else {None}
                },
            )

        term = one_or_create(
            db,
            AcademicTerm,
            {"name": "Осенний семестр 2026/2027"},
            {"starts_on": TERM_START, "ends_on": TERM_END},
        )
        teacher_names = {
            "История России": "Нина Павловна Белова",
            "Математический анализ": "Виктор Сергеевич Громов",
            "Теория вероятностей и математическая статистика": "Виктор Сергеевич Громов",
            "Философия": "Людмила Аркадьевна Соколова",
            "Основы российской государственности": "Александр Петрович Морозов",
            "Правоведение": "Александр Петрович Морозов",
            "Основы экономики": "Татьяна Михайловна Егорова",
            "Введение в зельеварение": "Елена Борисовна Рябинина",
            "Общая и неорганическая химия": "Валентина Семёновна Котова",
            "Основы алхимического анализа": "Валентина Семёновна Котова",
            "Теоретические основы мантики": "Вадим Олегович Чернов",
            "Практикум по гадательным системам": "Маргарита Игоревна Воронцова",
            "Интерпретация предсказательных данных": "Вадим Олегович Чернов",
            "Методы вероятностного прогнозирования": "Виктор Сергеевич Громов",
            "Этика предсказательной деятельности": "Людмила Аркадьевна Соколова",
            "Иностранный язык": "Татьяна Михайловна Егорова",
            "Информатика": "Виктор Сергеевич Громов",
            "Физическая культура и спорт": "Александр Петрович Морозов",
            "Безопасность жизнедеятельности": "Александр Петрович Морозов",
            "Социология": "Людмила Аркадьевна Соколова",
            "Методология научных исследований": "Вадим Олегович Чернов",
            "Травология": "Елена Борисовна Рябинина",
            "Рунная аналитика": "Вадим Олегович Чернов",
            "Защита от тёмных искусств": "Северин Аркадьевич Ворон",
        }
        teacher_departments = {
            "Нина Павловна Белова": "Кафедра гуманитарных наук",
            "Виктор Сергеевич Громов": "Кафедра естественных наук",
            "Людмила Аркадьевна Соколова": "Кафедра гуманитарных наук",
            "Александр Петрович Морозов": "Кафедра прикладных дисциплин",
            "Татьяна Михайловна Егорова": "Кафедра гуманитарных наук",
            "Елена Борисовна Рябинина": "Кафедра прикладных дисциплин",
            "Валентина Семёновна Котова": "Кафедра естественных наук",
            "Вадим Олегович Чернов": "Кафедра прикладных дисциплин",
            "Маргарита Игоревна Воронцова": "Кафедра прикладных дисциплин",
            "Северин Аркадьевич Ворон": "Кафедра прикладных дисциплин",
        }
        teacher_records = {}
        for name in teacher_departments:
            teacher_records[name] = one_or_create(
                db,
                Teacher,
                {"full_name": name},
                {"department_id": departments[teacher_departments[name]].id},
            )
        if legacy_mvp1_upgrade:
            clear_owned_legacy_lessons(
                db,
                {group.id for group in groups.values()},
                {teacher.id for teacher in teacher_records.values()},
            )
        severin = teacher_records["Северин Аркадьевич Ворон"]
        existing_severin_user = db.scalar(
            select(User.id).where(User.login == "demo-severin-voron").limit(1)
        )
        teacher_user = ensure_demo_user(
            db,
            "demo-severin-voron",
            "Северин Аркадьевич Ворон",
            "teacher",
            "DEMO_TEACHER_PASSWORD",
        )
        if severin.user_id not in {None, teacher_user.id}:
            raise RuntimeError("Demonstration teacher is already linked to another account")
        severin.user_id = teacher_user.id

        dean = db.scalar(select(OrgUnit).where(OrgUnit.name == "Деканат естественных наук"))
        dean_user = ensure_demo_user(
            db,
            "demo-dean",
            "Элеонора Павловна Чарова",
            "staff",
            "DEMO_DEAN_STAFF_PASSWORD",
        )
        accounting_user = ensure_demo_user(
            db,
            "demo-accounting",
            "Агата Романовна Златова",
            "staff",
            "DEMO_ACCOUNTING_STAFF_PASSWORD",
        )
        staff_profiles = {}
        new_staff_profiles = set()
        for account, unit in ((dean_user, dean), (accounting_user, accounting)):
            profile = db.scalar(select(StaffProfile).where(StaffProfile.user_id == account.id))
            if profile is None:
                profile = StaffProfile(user_id=account.id, org_unit_id=unit.id)
                db.add(profile)
                db.flush()
                new_staff_profiles.add(profile.id)
            elif profile.org_unit_id != unit.id:
                raise RuntimeError("Existing demonstration staff profile has an unexpected scope")
            staff_profiles[account.id] = profile
        desired_permissions = {
            dean_user.id: (
                ("students.read", None),
                ("students.status.edit", None),
                ("grades.edit", None),
                ("attendance.edit", None),
                ("schedule.edit", None),
                ("applications.review", dean.id),
                ("news.publish", dean.id),
            ),
            accounting_user.id: (("applications.review", accounting.id),),
        }
        for account_id, grants in desired_permissions.items():
            profile = staff_profiles[account_id]
            if profile.id not in new_staff_profiles:
                continue
            db.add_all(
                StaffPermission(
                    staff_profile_id=profile.id,
                    permission_code=code,
                    scope_org_unit_id=scope,
                )
                for code, scope in grants
            )
        db.flush()
        teachers = {subject: teacher_records[name] for subject, name in teacher_names.items()}

        buildings = {
            "ГУК": one_or_create(
                db,
                Building,
                {"name": "Главный учебный корпус (ГУК)"},
                {"address": "Университетский проспект, 1"},
            ),
            "УЛК": one_or_create(
                db,
                Building,
                {"name": "Учебно-лабораторный корпус (УЛК)"},
                {"address": "Университетский проспект, 3"},
            ),
            "СБ": one_or_create(
                db, Building, {"name": "Северная башня"}, {"address": "Университетский проспект, 5"}
            ),
            "СК": one_or_create(
                db,
                Building,
                {"name": "Спортивный комплекс"},
                {"address": "Университетский проспект, 7"},
            ),
        }
        room_names = {
            "ГУК": ("201", "215", "304", "402"),
            "УЛК": ("106", "112", "213", "Лаборатория № 3"),
            "СБ": ("13", "14"),
            "СК": ("Зал 1",),
        }
        rooms = {
            (building_key, room_name): one_or_create(
                db,
                Room,
                {"building_id": building.id, "name": room_name},
                {},
            )
            for building_key, building in buildings.items()
            for room_name in room_names[building_key]
        }

        subjects = {
            "pz": [
                ("Математический анализ", "exam", "П"),
                ("История России", "exam", "Г"),
                ("Иностранный язык", "pass_fail", "Г"),
                ("Информатика", "graded_pass", "П"),
                ("Общая и неорганическая химия", "exam", "П"),
                ("Введение в зельеварение", "exam", "М"),
                ("Травология", "graded_pass", "М"),
                ("Основы алхимического анализа", "graded_pass", "М"),
                ("Защита от тёмных искусств", "graded_pass", "М"),
            ],
            "pm": [
                ("Теория вероятностей и математическая статистика", "exam", "П"),
                ("Иностранный язык", "pass_fail", "Г"),
                ("Философия", "pass_fail", "Г"),
                ("Физическая культура и спорт", "pass_fail", "М"),
                ("Теоретические основы мантики", "exam", "М"),
                ("Практикум по гадательным системам", "graded_pass", "М"),
                ("Методы вероятностного прогнозирования", "exam", "П"),
                ("Рунная аналитика", "graded_pass", "М"),
                ("Защита от тёмных искусств", "graded_pass", "М"),
            ],
        }
        offerings = {}
        desired_course_group_pairs: set[tuple[int, int]] = set()
        for key, entries in subjects.items():
            for subject_name, attestation, _ in entries:
                discipline = one_or_create(db, Discipline, {"name": subject_name}, {"code": None})
                offering = one_or_create(
                    db,
                    CourseOffering,
                    {"discipline_id": discipline.id, "term_id": term.id},
                    {"attestation_type": attestation},
                )
                offerings[(key, subject_name)] = offering
                desired_course_group_pairs.add((offering.id, groups[key].id))
                if db.get(CourseGroup, (offering.id, groups[key].id)) is None:
                    db.add(CourseGroup(course_offering_id=offering.id, group_id=groups[key].id))
                    db.flush()
        if legacy_mvp1_upgrade:
            remove_obsolete_legacy_course_groups(
                db,
                {group.id for group in groups.values()},
                desired_course_group_pairs,
            )

        # Ordinary weekday timetable templates are expanded into concrete lessons.
        # Slot tuples: weekday (Mon=0), start time, subject index, room, lesson kind.
        templates = {
            "pz": [
                (0, "09:00", 0, ("ГУК", "201"), "lecture", None),
                (0, "11:00", 3, ("ГУК", "215"), "lecture", None),
                (0, "13:00", 4, ("ГУК", "304"), "lecture", None),
                (0, "16:30", 5, ("ГУК", "304"), "lecture", None),
                (1, "09:00", 1, ("ГУК", "304"), "lecture", None),
                (1, "11:00", 2, ("ГУК", "215"), "seminar", None),
                (1, "13:00", 7, ("УЛК", "213"), "lab", None),
                (1, "16:30", 6, ("УЛК", "112"), "lab", None),
                (2, "09:00", 0, ("ГУК", "201"), "lecture", None),
                (2, "11:00", 6, ("УЛК", "112"), "lecture", None),
                (2, "13:00", 8, ("ГУК", "402"), "lecture", None),
                (2, "15:00", 5, ("УЛК", "Лаборатория № 3"), "lab", None),
                (3, "09:00", 4, ("УЛК", "106"), "lab", None),
                (3, "11:00", 3, ("ГУК", "215"), "lab", None),
                (3, "13:00", 5, ("УЛК", "Лаборатория № 3"), "lab", None),
                (3, "15:00", 8, ("ГУК", "402"), "seminar", None),
                (4, "09:00", 6, ("УЛК", "112"), "lab", None),
                (4, "11:00", 0, ("ГУК", "201"), "seminar", None),
                (4, "13:00", 7, ("УЛК", "213"), "seminar", None),
            ],
            "pm": [
                (0, "09:00", 1, ("ГУК", "215"), "seminar", None),
                (0, "11:00", 4, ("ГУК", "304"), "lecture", None),
                (0, "13:00", 6, ("ГУК", "215"), "lecture", None),
                (0, "16:30", 8, ("ГУК", "402"), "lecture", None),
                (1, "09:00", 0, ("ГУК", "201"), "lecture", None),
                (1, "11:00", 4, ("ГУК", "304"), "lecture", None),
                (1, "16:30", 7, ("ГУК", "304"), "lecture", None),
                (1, "15:00", 5, ("УЛК", "Лаборатория № 3"), "lab", "1-я подгруппа"),
                (2, "09:00", 3, ("СК", "Зал 1"), "seminar", None),
                (2, "11:00", 2, ("ГУК", "215"), "seminar", None),
                (2, "13:00", 5, ("УЛК", "213"), "lab", "2-я подгруппа"),
                (2, "15:00", 8, ("ГУК", "402"), "seminar", None),
                (2, "17:00", 5, ("УЛК", "Лаборатория № 3"), "lab", "1-я подгруппа"),
                (3, "09:00", 0, ("ГУК", "201"), "lecture", None),
                (3, "11:00", 5, ("УЛК", "213"), "seminar", None),
                (3, "13:00", 4, ("ГУК", "304"), "seminar", None),
                (3, "15:00", 7, ("УЛК", "106"), "lab", None),
                (4, "09:00", 0, ("ГУК", "201"), "seminar", None),
                (4, "13:00", 6, ("ГУК", "304"), "seminar", None),
                (4, "15:00", 5, ("УЛК", "213"), "lab", "2-я подгруппа"),
                (4, "17:00", 5, ("УЛК", "Лаборатория № 3"), "lab", "1-я подгруппа"),
            ],
        }
        generated: dict[tuple[str, date, str], Lesson] = {}
        current = TERM_START
        while current <= TERM_END:
            if current.weekday() < 5 and current not in {date(2026, 11, 4), date(2027, 1, 1)}:
                for key, slots in templates.items():
                    for weekday, start_time, subject_index, room_key, kind, subgroup_name in slots:
                        if current.weekday() != weekday:
                            continue
                        subject_name = subjects[key][subject_index][0]
                        starts = datetime.combine(current, time.fromisoformat(start_time), MOSCOW)
                        identity = {
                            "course_offering_id": offerings[(key, subject_name)].id,
                            "starts_at": starts,
                        }
                        existing_lesson = db.scalar(select(Lesson).filter_by(**identity))
                        allowed_statuses = set()
                        if current == date(2026, 11, 19):
                            if key == "pz" and subject_name == "Общая и неорганическая химия":
                                allowed_statuses.add("cancelled")
                            if key == "pz" and subject_name == "Введение в зельеварение":
                                allowed_statuses.add("moved")
                            if key == "pm" and subject_name == "Практикум по гадательным системам":
                                allowed_statuses.add("moved")
                        status_mutations = (
                            {"status": allowed_statuses}
                            if existing_lesson and existing_lesson.status in allowed_statuses
                            else {}
                        )
                        lesson = one_or_create(
                            db,
                            Lesson,
                            identity,
                            {
                                "teacher_id": teachers[subject_name].id,
                                "ends_at": starts + timedelta(minutes=90),
                                "kind": kind,
                                "status": "scheduled",
                                "previous_lesson_id": None,
                                "is_additional": False,
                                "created_by_user_id": None,
                            },
                            mutable=status_mutations,
                        )
                        generated[(key, current, subject_name)] = lesson
                        room = rooms[room_key]
                        expected_groups = {
                            (
                                groups[key].id,
                                subgroups[subgroup_name].id if subgroup_name is not None else None,
                            )
                        }
                        expected_rooms = {room.id}
                        if existing_lesson is None:
                            create_lesson_relations(db, lesson, expected_groups, expected_rooms)
                        else:
                            require_lesson_relations(db, lesson, expected_groups, expected_rooms)
            current += timedelta(days=1)
        db.flush()

        # 19 November exceptions. The replacement node keeps a previous_lesson_id
        # link and remains the terminal scheduled position in the existing model.
        def move_lesson(
            key: str, subject: str, from_day: date, to_day: date, to_time: str, room_key
        ):
            source = generated[(key, from_day, subject)]
            require_seed_status(source, {"scheduled", "moved"})
            expected_groups = {
                (row.group_id, row.subgroup_id)
                for row in db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == source.id))
            }
            source_room_id = rooms[
                next(
                    room_key
                    for weekday, start_time, subject_index, room_key, _kind, _subgroup in templates[
                        key
                    ]
                    if weekday == from_day.weekday() and subjects[key][subject_index][0] == subject
                )
            ].id
            require_lesson_relations(db, source, expected_groups, {source_room_id})
            source.status = "moved"
            replacement_start = datetime.combine(to_day, time.fromisoformat(to_time), MOSCOW)
            replacement_identity = {
                "course_offering_id": source.course_offering_id,
                "starts_at": replacement_start,
            }
            existing_replacements = db.scalars(
                select(Lesson).filter_by(**replacement_identity)
            ).all()
            if len(existing_replacements) > 1:
                raise RuntimeError("Ambiguous existing demonstration lesson identity")
            replacement_is_new = not existing_replacements
            replacement = one_or_create(
                db,
                Lesson,
                replacement_identity,
                {
                    "teacher_id": source.teacher_id,
                    "ends_at": replacement_start + timedelta(minutes=90),
                    "kind": source.kind,
                    "status": "scheduled",
                    "previous_lesson_id": source.id,
                    "is_additional": False,
                    "created_by_user_id": None,
                },
                mutable={"status": {"moved"}},
            )
            expected_rooms = {rooms[room_key].id}
            if replacement_is_new:
                create_lesson_relations(db, replacement, expected_groups, expected_rooms)
            else:
                require_lesson_relations(db, replacement, expected_groups, expected_rooms)
            generated[(key, to_day, subject)] = replacement
            return replacement

        # Thursday PZ lab cancellation; PZ introductory lesson moved through two positions.
        chemistry_source = generated[("pz", date(2026, 11, 19), "Общая и неорганическая химия")]
        require_seed_status(chemistry_source, {"scheduled", "cancelled"})
        chemistry_source.status = "cancelled"
        root = generated[("pz", date(2026, 11, 19), "Введение в зельеварение")]
        require_seed_status(root, {"scheduled", "moved"})
        root.status = "moved"
        middle = move_lesson(
            "pz",
            "Введение в зельеварение",
            date(2026, 11, 19),
            date(2026, 11, 20),
            "15:00",
            ("ГУК", "304"),
        )
        require_seed_status(middle, {"scheduled", "moved"})
        middle.status = "moved"
        final_start = datetime(2026, 11, 23, 15, tzinfo=MOSCOW)
        final_identity = {
            "course_offering_id": middle.course_offering_id,
            "starts_at": final_start,
        }
        existing_finals = db.scalars(select(Lesson).filter_by(**final_identity)).all()
        if len(existing_finals) > 1:
            raise RuntimeError("Ambiguous existing demonstration lesson identity")
        final_is_new = not existing_finals
        final = one_or_create(
            db,
            Lesson,
            final_identity,
            {
                "teacher_id": middle.teacher_id,
                "ends_at": final_start + timedelta(minutes=90),
                "kind": middle.kind,
                "status": "scheduled",
                "previous_lesson_id": middle.id,
                "is_additional": False,
                "created_by_user_id": None,
            },
        )
        final_room = rooms[("ГУК", "304")]
        final_groups = {(groups["pz"].id, None)}
        final_rooms = {final_room.id}
        if final_is_new:
            create_lesson_relations(db, final, final_groups, final_rooms)
        else:
            require_lesson_relations(db, final, final_groups, final_rooms)
        generated[("pz", date(2026, 11, 23), "Введение в зельеварение")] = final
        move_lesson(
            "pm",
            "Практикум по гадательным системам",
            date(2026, 11, 19),
            date(2026, 11, 21),
            "11:00",
            ("СБ", "14"),
        )

        # The current assignment table is the sole journal authorization source.
        # Bootstrap each teacher once; a later revocation is intentionally not repaired.
        assignment_candidates: dict[int, set[tuple[int, int]]] = {}
        for lesson in db.scalars(select(Lesson)).all():
            if lesson.teacher_id is None:
                continue
            for group_id in db.scalars(
                select(LessonGroup.group_id).where(LessonGroup.lesson_id == lesson.id)
            ):
                assignment_candidates.setdefault(lesson.teacher_id, set()).add(
                    (lesson.course_offering_id, group_id)
                )
        for teacher_id, pairs in assignment_candidates.items():
            teacher_record = db.get(Teacher, teacher_id)
            # Once a teacher account exists, assignment rows may have been
            # deliberately revoked by an administrator. Seed assignments only
            # before that teacher has an account; Severin's first seed is the
            # sole exception because his demo account is created in this run.
            if teacher_record.user_id is not None and not (
                teacher_id == severin.id and existing_severin_user is None
            ):
                continue
            has_assignments = (
                db.scalar(
                    select(TeachingAssignment.id)
                    .where(TeachingAssignment.teacher_id == teacher_id)
                    .limit(1)
                )
                is not None
            )
            if not has_assignments:
                db.add_all(
                    TeachingAssignment(
                        teacher_id=teacher_id,
                        course_offering_id=offering_id,
                        group_id=group_id,
                    )
                    for offering_id, group_id in sorted(pairs)
                )

        for group_key in ("pz", "pm"):
            offering = offerings[(group_key, "Защита от тёмных искусств")]
            for publication_key, title, body in (
                (
                    "preparation",
                    "Подготовка к практическому занятию по защитным чарам",
                    "На следующем семинаре продолжим отработку базовых защитных заклинаний "
                    "и способов нейтрализации тёмных чар. Повторите материал последней лекции "
                    "и подготовьтесь к практической работе. За выполнение заданий можно "
                    "получить до двух баллов.",
                ),
                (
                    "safety",
                    "Правила безопасности при отработке контрзаклинаний",
                    "Напоминаю о необходимости соблюдать правила безопасности на практических "
                    "занятиях. Самостоятельное применение неразрешённых заклинаний и "
                    "эксперименты с неизвестными магическими артефактами запрещены. "
                    "Все упражнения выполняются под наблюдением преподавателя.",
                ),
            ):
                identity = {
                    "teacher_id": severin.id,
                    "publication_key": uuid5(
                        NAMESPACE_URL, f"unispacedemo:{publication_key}:{group_key}"
                    ),
                }
                announcement = db.scalar(select(TeacherAnnouncement).filter_by(**identity))
                if announcement is None:
                    db.add(
                        TeacherAnnouncement(
                            **identity,
                            course_offering_id=offering.id,
                            group_id=groups[group_key].id,
                            title=title,
                            body=body,
                            is_important=False,
                        )
                    )

        validate_active_schedule(db)

        # Seed one approved two-point work for every scheduled seminar, including
        # future seminars. Results are created only for selected past sessions.
        for (group_key, lesson_date, subject_name), lesson in generated.items():
            if lesson.kind != "seminar" or lesson.status != "scheduled":
                continue
            offering = offerings[(group_key, subject_name)]
            assessment = one_or_create(
                db,
                Assessment,
                {
                    "course_offering_id": offering.id,
                    "title": f"Семинар {lesson_date.isoformat()}",
                },
                {
                    "type": "seminar",
                    "max_score": 2,
                    "description": "Практическая работа на семинаре",
                    "created_by_user_id": None,
                },
            )
            assignment = one_or_create(
                db,
                AssessmentGroup,
                {"assessment_id": assessment.id, "group_id": groups[group_key].id},
                {
                    "planned_date": lesson_date,
                    "lesson_id": lesson.id,
                    "date_needs_confirmation": False,
                },
            )
            if assignment.lesson_id != lesson.id or assignment.planned_date != lesson_date:
                raise RuntimeError("Existing seminar assessment is linked to another lesson")
            if lesson_date > date(2026, 11, 20):
                continue
            student = students[group_key]
            existing_result = db.scalar(
                select(AssessmentResult).where(
                    AssessmentResult.assessment_group_id == assignment.id,
                    AssessmentResult.student_id == student.id,
                )
            )
            if existing_result is None:
                if (group_key == "pz" and lesson_date.day % 3 == 0) or (
                    group_key == "pm" and lesson_date.day % 4 == 0
                ):
                    continue
                score = (
                    (1 if lesson_date.day % 7 == 0 else 2)
                    if group_key == "pm"
                    else (0 if lesson_date.day % 11 == 0 else 2 if lesson_date.day % 7 == 0 else 1)
                )
                db.add(
                    AssessmentResult(
                        assessment_group_id=assignment.id,
                        student_id=student.id,
                        score=score,
                        graded_at=datetime.combine(lesson_date, time(12), MOSCOW),
                    )
                )

        absence_lessons = {
            ("pz", date(2026, 11, 16), "Математический анализ"),
            ("pz", date(2026, 11, 17), "История России"),
            ("pz", date(2026, 11, 18), "Введение в зельеварение"),
            ("pm", date(2026, 11, 18), "Философия"),
        }
        for key, absent_date, subject_name in absence_lessons:
            lesson = generated.get((key, absent_date, subject_name))
            if lesson is None or lesson.status != "scheduled":
                raise RuntimeError("Seed attendance requires a scheduled past lesson")
            student = students[key]
            identity = {"lesson_id": lesson.id, "student_id": student.id}
            current_attendance = db.get(Attendance, (lesson.id, student.id))
            if current_attendance is None:
                db.add(
                    Attendance(
                        **identity,
                        origin_group_id=student.group_id,
                        origin_subgroup_id=student.subgroup_id,
                        membership_version=student.membership_version,
                        status="absent",
                        marked_by_user_id=dean_user.id,
                        updated_at=datetime.combine(absent_date, time(12), MOSCOW),
                    )
                )

        # Current works only; first year has no final results or closed prior terms.
        assessment_profiles = {
            "pz": {
                "Математический анализ": ("Контрольная работа", 20, 0),
                "История России": ("Эссе", 10, None),
                "Общая и неорганическая химия": ("Лабораторный отчёт", 15, 5),
                "Введение в зельеварение": ("Практическая работа", 20, 16),
            },
            "pm": {
                "Теория вероятностей и математическая статистика": ("Контрольная работа", 20, 19),
                "Методы вероятностного прогнозирования": ("Практикум", 20, 20),
                "Теоретические основы мантики": ("Аналитическая работа", 15, 14),
                "Философия": ("Эссе", 10, 9),
            },
        }
        for key, profile in assessment_profiles.items():
            for subject_name, (title, max_score, score) in profile.items():
                offering = offerings[(key, subject_name)]
                assessment = one_or_create(
                    db,
                    Assessment,
                    {"course_offering_id": offering.id, "title": title},
                    {
                        "type": "test",
                        "max_score": max_score,
                        "description": "Текущая работа",
                        "created_by_user_id": None,
                    },
                )
                assignment = one_or_create(
                    db,
                    AssessmentGroup,
                    {"assessment_id": assessment.id, "group_id": groups[key].id},
                    {
                        "planned_date": date(2026, 11, 10),
                        "lesson_id": None,
                        "date_needs_confirmation": False,
                    },
                )
                result = db.scalar(
                    select(AssessmentResult).where(
                        AssessmentResult.assessment_group_id == assignment.id,
                        AssessmentResult.student_id == students[key].id,
                    )
                )
                if score is not None:
                    if result is None:
                        db.add(
                            AssessmentResult(
                                assessment_group_id=assignment.id,
                                student_id=students[key].id,
                                score=score,
                                graded_at=datetime(2026, 11, 10, 12, tzinfo=UTC),
                            )
                        )
                    else:
                        expected_graded_at = datetime(2026, 11, 10, 12, tzinfo=UTC)
                        if result.score != score or result.graded_at != expected_graded_at:
                            raise RuntimeError(
                                "Existing assessment result differs from demonstration data"
                            )
                        result.score = score
                        result.graded_at = expected_graded_at

        for service_code in ("study_certificate", "academic_transcript", "academic_leave"):
            academic_service = db.scalar(
                select(ServiceType).where(ServiceType.code == service_code)
            )
            if academic_service is None:
                raise RuntimeError(
                    f"Required {service_code} service is missing; apply migrations first"
                )
            academic_service.responsible_org_unit_id = dean.id
        accounting_certificate = db.scalar(
            select(ServiceType).where(ServiceType.code == "accounting_certificate")
        )
        if accounting_certificate is None:
            raise RuntimeError(
                "Required accounting_certificate service is missing; apply migrations first"
            )
        existing_accounting_units = db.scalars(
            select(OrgUnit).where(OrgUnit.type == "accounting")
        ).all()
        if len(existing_accounting_units) != 1 or existing_accounting_units[0].id != accounting.id:
            raise RuntimeError("Ambiguous accounting demo configuration")
        accounting_certificate.responsible_org_unit_id = accounting.id

        for title, body, published_at in DEMO_NEWS:
            allowed_bodies = {body}
            if title == DEMO_NEWS[0][0]:
                allowed_bodies.update(
                    {LEGACY_INTRO_NEWS_BODY, PREVIOUS_INTRO_NEWS_BODY, MVP1_INTRO_NEWS_BODY}
                )
            if title in LEGACY_DEMO_NEWS_BODIES:
                allowed_bodies.add(LEGACY_DEMO_NEWS_BODIES[title])
            existing_news = db.scalars(select(News).where(News.title == title)).all()
            if existing_news:
                if len(existing_news) != 1:
                    raise RuntimeError("Ambiguous existing demonstration news identity")
                if (
                    existing_news[0].published_at != published_at
                    or existing_news[0].author_user_id is not None
                    or existing_news[0].body not in allowed_bodies
                    or existing_news[0].is_published is not True
                ):
                    raise RuntimeError(
                        "Existing news identity is not owned by the demonstration seed"
                    )
            one_or_create(
                db,
                News,
                {"title": title},
                {
                    "body": body,
                    "author_user_id": None,
                    "published_at": published_at,
                    "is_published": True,
                },
                mutable={"body": allowed_bodies},
            )
        for key, notification_type, title, body in (
            (
                "pz",
                "academic_update",
                "План на первую сессию",
                "Проверьте даты консультаций по дисциплинам в расписании. "
                "Итоговые результаты первого семестра ещё не выставлены.",
            ),
            (
                "pm",
                "academic_update",
                "Результаты текущих работ обновлены",
                "В личном кабинете доступны новые баллы по курсам текущего семестра.",
            ),
            (
                "pz",
                "schedule_update",
                "Изменение занятий 19 ноября",
                "Лабораторная в УЛК отменена, а занятие по введению в зельеварение "
                "перенесено. Проверьте расписание.",
            ),
            (
                "pm",
                "schedule_update",
                "Перенос практикума 19 ноября",
                "Практикум по гадательным системам пройдёт 21 ноября в Северной башне.",
            ),
        ):
            one_or_create(
                db,
                Notification,
                {"user_id": users[key].id, "type": notification_type, "title": title},
                {
                    "body": body,
                    "entity_type": None,
                    "entity_id": None,
                    "created_at": datetime(2026, 11, 10, 12, tzinfo=MOSCOW),
                },
            )
    print("Demonstration data applied; user-created applications were left unchanged.")


if __name__ == "__main__":
    try:
        seed_demo_data()
    except Exception as error:
        # Exception details can include SQL parameters; never send them to logs.
        print(
            f"Demonstration seed refused or failed ({type(error).__name__}); "
            "transaction rolled back.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
