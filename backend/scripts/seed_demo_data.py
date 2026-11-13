"""Explicitly seed the fictional MVP 1 demonstration university."""

from __future__ import annotations

import os
import socket
import sys
from datetime import UTC, date, datetime, time, timedelta
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
    Student,
    StudyGroup,
    Teacher,
    User,
)

MOSCOW = ZoneInfo("Europe/Moscow")
TERM_START = date(2026, 9, 1)
TERM_END = date(2027, 1, 31)
DEMO_NEWS = (
    (
        "Об изменении расписания занятий 19 ноября в учебно-лабораторном корпусе",
        "19 ноября 2026 года в учебно-лабораторном корпусе проводится внеплановая "
        "проверка защитных контуров из-за нестабильного магического фона. "
        "Лабораторная работа по общей и неорганической "
        "химии отменена. Введение в зельеварение сначала переносится на 20 ноября, "
        "затем на окончательную дату — 23 ноября 2026 года — в Главный "
        "учебный корпус. Практикум по гадательным системам переносится с 19 на 21 "
        "ноября в Северную башню. Проверьте личное расписание: исходные занятия "
        "помечены как перенесённые или отменённые, новые позиции связаны с ними.",
        datetime(2026, 11, 10, 9, tzinfo=MOSCOW),
    ),
    (
        "Подписывайтесь на официальный канал университета в MAX",
        "Университет готовит официальный канал в MAX для новостей и объявлений. "
        "Адрес канала будет опубликован на этой странице после его подтверждения. "
        "Не используйте ссылки на неофициальные каналы.",
        datetime(2026, 11, 9, 10, tzinfo=MOSCOW),
    ),
    (
        "Приглашение Министерства Магии в мракоборцы",
        "Вымышленный отдел практик и трудоустройства публикует учебный пример "
        "объявления о стажировке. Министерство Магии и вакансия придуманы для "
        "демонстрации; у объявления нет действующих контактов или ссылки для отклика.",
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
    for variable in ("DEMO_STUDENT_A_PASSWORD", "DEMO_STUDENT_B_PASSWORD"):
        password = os.getenv(variable, "")
        if len(password) < 12 or password != password.strip():
            raise RuntimeError(
                f"{variable} must be supplied externally and contain at least 12 characters"
            )
    if os.environ["DEMO_STUDENT_A_PASSWORD"] == os.environ["DEMO_STUDENT_B_PASSWORD"]:
        raise RuntimeError("Each demonstration student must have a different password")
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
    groups_by_lesson: dict[int, set[int]] = {}
    for lesson in lessons:
        rooms_by_lesson[lesson.id] = set(
            session.scalars(select(LessonRoom.room_id).where(LessonRoom.lesson_id == lesson.id))
        )
        groups_by_lesson[lesson.id] = set(
            session.scalars(select(LessonGroup.group_id).where(LessonGroup.lesson_id == lesson.id))
        )
    for index, left in enumerate(lessons):
        for right in lessons[index + 1 :]:
            if left.starts_at >= right.ends_at or right.starts_at >= left.ends_at:
                continue
            if (
                left.teacher_id == right.teacher_id
                or rooms_by_lesson[left.id] & rooms_by_lesson[right.id]
                or groups_by_lesson[left.id] & groups_by_lesson[right.id]
            ):
                raise RuntimeError("Generated schedule contains an overlapping active lesson")


def require_seed_status(lesson: Lesson, accepted_statuses: set[str]) -> None:
    if lesson.status not in accepted_statuses:
        raise RuntimeError("Existing lesson status is not owned by the demonstration seed")


def seed_demo_data() -> None:
    require_safe_target()
    with SessionLocal.begin() as db:
        demo_logins = ("demo-pz101", "demo-pm201")
        existing_demo_users = set(
            db.scalars(select(User.login).where(User.login.in_(demo_logins))).all()
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
                    "direction_code": "04.03.01",
                    "direction_name": "Химия",
                    "faculty_id": faculty.id,
                },
            ),
            "pm": one_or_create(
                db,
                Program,
                {"code": "ПМ"},
                {
                    "name": "Прикладная мантика и прогностика",
                    "direction_code": "01.03.02",
                    "direction_name": "Прикладная математика и информатика",
                    "faculty_id": faculty.id,
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
                    ("ПЗ", "Прикладное зельеварение", "04.03.01", "Химия")
                    if key == "pz"
                    else (
                        "ПМ",
                        "Прикладная мантика и прогностика",
                        "01.03.02",
                        "Прикладная математика и информатика",
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
                {"group_id": groups[key].id, "academic_status": "enrolled"},
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
        }
        teacher_records = {}
        for name in teacher_departments:
            teacher_records[name] = one_or_create(
                db,
                Teacher,
                {"full_name": name},
                {"department_id": departments[teacher_departments[name]].id},
            )
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
        }
        room_names = {
            "ГУК": ("201", "215", "304", "402"),
            "УЛК": ("106", "112", "213", "Лаборатория № 3"),
            "СБ": ("13", "14"),
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
                ("Основы российской государственности", "pass_fail", "Г"),
                ("История России", "exam", "Г"),
                ("Математический анализ", "exam", "П"),
                ("Философия", "pass_fail", "Г"),
                ("Иностранный язык", "pass_fail", "Г"),
                ("Информатика", "graded_pass", "П"),
                ("Основы экономики", "exam", "Г"),
                ("Физическая культура и спорт", "pass_fail", "М"),
                ("Безопасность жизнедеятельности", "pass_fail", "М"),
                ("Общая и неорганическая химия", "exam", "П"),
                ("Введение в зельеварение", "exam", "М"),
                ("Основы алхимического анализа", "graded_pass", "М"),
            ],
            "pm": [
                ("Философия", "pass_fail", "Г"),
                ("Теория вероятностей и математическая статистика", "exam", "П"),
                ("Основы экономики", "exam", "Г"),
                ("Правоведение", "pass_fail", "Г"),
                ("Иностранный язык", "pass_fail", "Г"),
                ("Социология", "exam", "Г"),
                ("Методология научных исследований", "graded_pass", "Г"),
                ("Теоретические основы мантики", "exam", "М"),
                ("Практикум по гадательным системам", "graded_pass", "М"),
                ("Интерпретация предсказательных данных", "exam", "М"),
                ("Методы вероятностного прогнозирования", "exam", "П"),
                ("Этика предсказательной деятельности", "pass_fail", "Г"),
            ],
        }
        offerings = {}
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
                if db.get(CourseGroup, (offering.id, groups[key].id)) is None:
                    db.add(CourseGroup(course_offering_id=offering.id, group_id=groups[key].id))
                    db.flush()

        # Ordinary weekday timetable templates are expanded into concrete lessons.
        # Slot tuples: weekday (Mon=0), start time, subject index, room, lesson kind.
        templates = {
            "pz": [
                (0, "09:00", 2, ("ГУК", "201"), "lecture"),
                (0, "11:00", 4, ("ГУК", "215"), "seminar"),
                (1, "09:00", 1, ("ГУК", "304"), "lecture"),
                (1, "11:00", 0, ("ГУК", "201"), "lecture"),
                (1, "13:00", 8, ("УЛК", "112"), "seminar"),
                (2, "09:00", 7, ("ГУК", "304"), "seminar"),
                (2, "11:00", 5, ("ГУК", "402"), "lab"),
                (2, "13:00", 6, ("ГУК", "215"), "lecture"),
                (3, "09:00", 9, ("УЛК", "106"), "lab"),
                (3, "13:00", 10, ("УЛК", "Лаборатория № 3"), "lab"),
                (4, "09:00", 11, ("УЛК", "112"), "lab"),
                (4, "11:00", 3, ("ГУК", "215"), "seminar"),
            ],
            "pm": [
                (0, "09:00", 7, ("УЛК", "213"), "seminar"),
                (0, "13:00", 3, ("ГУК", "304"), "lecture"),
                (1, "09:00", 1, ("ГУК", "201"), "lecture"),
                (1, "11:00", 4, ("ГУК", "215"), "seminar"),
                (1, "13:00", 5, ("ГУК", "402"), "lecture"),
                (2, "09:00", 0, ("ГУК", "201"), "seminar"),
                (2, "11:00", 6, ("ГУК", "215"), "seminar"),
                (2, "13:00", 9, ("ГУК", "304"), "lecture"),
                (3, "09:00", 11, ("ГУК", "201"), "seminar"),
                (3, "11:00", 8, ("УЛК", "213"), "seminar"),
                (3, "13:00", 10, ("ГУК", "402"), "seminar"),
                (4, "09:00", 2, ("ГУК", "304"), "lecture"),
            ],
        }
        generated: dict[tuple[str, date, str], Lesson] = {}
        current = TERM_START
        while current <= TERM_END:
            if current.weekday() < 5 and current not in {date(2026, 11, 4), date(2027, 1, 1)}:
                for key, slots in templates.items():
                    for weekday, start_time, subject_index, room_key, kind in slots:
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
                        if not db.scalar(
                            select(LessonGroup.id).where(
                                LessonGroup.lesson_id == lesson.id,
                                LessonGroup.group_id == groups[key].id,
                            )
                        ):
                            db.add(LessonGroup(lesson_id=lesson.id, group_id=groups[key].id))
                        room = rooms[room_key]
                        if db.get(LessonRoom, (lesson.id, room.id)) is None:
                            db.add(LessonRoom(lesson_id=lesson.id, room_id=room.id))
            current += timedelta(days=1)
        db.flush()

        # 19 November exceptions. The replacement node keeps a previous_lesson_id
        # link and remains the terminal scheduled position in the existing model.
        def move_lesson(
            key: str, subject: str, from_day: date, to_day: date, to_time: str, room_key
        ):
            source = generated[(key, from_day, subject)]
            require_seed_status(source, {"scheduled", "moved"})
            source.status = "moved"
            replacement_start = datetime.combine(to_day, time.fromisoformat(to_time), MOSCOW)
            replacement = one_or_create(
                db,
                Lesson,
                {"course_offering_id": source.course_offering_id, "starts_at": replacement_start},
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
            for row in db.scalars(
                select(LessonGroup).where(LessonGroup.lesson_id == source.id)
            ).all():
                if not db.scalar(
                    select(LessonGroup.id).where(
                        LessonGroup.lesson_id == replacement.id,
                        LessonGroup.group_id == row.group_id,
                    )
                ):
                    db.add(LessonGroup(lesson_id=replacement.id, group_id=row.group_id))
            room = rooms[room_key]
            if db.get(LessonRoom, (replacement.id, room.id)) is None:
                db.add(LessonRoom(lesson_id=replacement.id, room_id=room.id))
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
        final = one_or_create(
            db,
            Lesson,
            {"course_offering_id": middle.course_offering_id, "starts_at": final_start},
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
        for row in db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == middle.id)).all():
            if not db.scalar(
                select(LessonGroup.id).where(
                    LessonGroup.lesson_id == final.id, LessonGroup.group_id == row.group_id
                )
            ):
                db.add(LessonGroup(lesson_id=final.id, group_id=row.group_id))
        final_room = rooms[("ГУК", "304")]
        if db.get(LessonRoom, (final.id, final_room.id)) is None:
            db.add(LessonRoom(lesson_id=final.id, room_id=final_room.id))
        move_lesson(
            "pm",
            "Практикум по гадательным системам",
            date(2026, 11, 19),
            date(2026, 11, 21),
            "11:00",
            ("СБ", "14"),
        )

        validate_active_schedule(db)

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

        study_certificate = db.scalar(
            select(ServiceType).where(ServiceType.code == "study_certificate")
        )
        if study_certificate is None:
            raise RuntimeError(
                "Required study_certificate service is missing; apply migrations first"
            )

        for title, body, published_at in DEMO_NEWS:
            allowed_bodies = {body}
            if title == DEMO_NEWS[0][0]:
                allowed_bodies.update({LEGACY_INTRO_NEWS_BODY, PREVIOUS_INTRO_NEWS_BODY})
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
