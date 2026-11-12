from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.models import (
    AuthSession,
    OrgUnit,
    Program,
    RefreshToken,
    Student,
    StudyGroup,
    Teacher,
    User,
)

pytestmark = pytest.mark.integration

EXPECTED_MODEL_TABLES = {
    "users",
    "auth_sessions",
    "refresh_tokens",
    "notifications",
    "org_units",
    "programs",
    "study_groups",
    "students",
    "teachers",
}
REQUIRED_COLUMNS = {
    "users": {"id", "login", "password_hash", "full_name", "role", "is_active", "created_at"},
    "auth_sessions": {"id", "user_id", "created_at", "expires_at"},
    "refresh_tokens": {"id", "session_id", "token_hash", "created_at", "expires_at"},
    "notifications": {
        "id",
        "user_id",
        "type",
        "title",
        "body",
        "created_at",
    },
    "org_units": {"id", "name", "type"},
    "programs": {"id", "code", "name", "direction_code", "direction_name", "faculty_id"},
    "study_groups": {"id", "name", "program_id", "course_number"},
    "students": {"id", "user_id", "group_id", "academic_status"},
    "teachers": {"id", "full_name"},
}
EXPECTED_FOREIGN_KEYS = {
    "auth_sessions": {("user_id", "users", "id")},
    "refresh_tokens": {
        ("session_id", "auth_sessions", "id"),
        ("parent_token_id", "refresh_tokens", "id"),
    },
    "notifications": {("user_id", "users", "id")},
    "org_units": {("parent_id", "org_units", "id")},
    "programs": {("faculty_id", "org_units", "id")},
    "study_groups": {("program_id", "programs", "id")},
    "students": {("user_id", "users", "id"), ("group_id", "study_groups", "id")},
    "teachers": {("user_id", "users", "id"), ("department_id", "org_units", "id")},
}
FIXTURE_PASSWORD_HASH = "argon2id$fixture-only$not-a-secret"


def add_user(
    session,
    login: str = "student.one",
    *,
    role: str = "student",
    is_active: bool = True,
) -> User:
    user = User(
        login=login,
        password_hash=FIXTURE_PASSWORD_HASH,
        full_name=f"Test User {login}",
        role=role,
        is_active=is_active,
    )
    session.add(user)
    session.flush()
    return user


def add_study_group(session, suffix: str) -> StudyGroup:
    faculty = OrgUnit(name=f"Faculty {suffix}", type="faculty")
    session.add(faculty)
    session.flush()

    program = Program(
        code=f"program-{suffix}",
        name=f"Program {suffix}",
        direction_code=f"direction-{suffix}",
        direction_name=f"Direction {suffix}",
        faculty_id=faculty.id,
    )
    session.add(program)
    session.flush()

    group = StudyGroup(name=f"Group {suffix}", program_id=program.id, course_number=1)
    session.add(group)
    session.flush()
    return group


def add_auth_session(session, user: User, *, created_at: datetime | None = None) -> AuthSession:
    created_at = created_at or datetime.now(UTC)
    auth_session = AuthSession(
        user_id=user.id,
        created_at=created_at,
        expires_at=created_at + timedelta(days=7),
    )
    session.add(auth_session)
    session.flush()
    return auth_session


def add_refresh_token(
    session,
    auth_session: AuthSession,
    token_hash: bytes,
    *,
    parent_token_id: int | None = None,
    created_at: datetime | None = None,
    expires_at: datetime | None = None,
    used_at: datetime | None = None,
    revoked_at: datetime | None = None,
) -> RefreshToken:
    created_at = created_at or datetime.now(UTC)
    token = RefreshToken(
        session_id=auth_session.id,
        token_hash=token_hash,
        parent_token_id=parent_token_id,
        created_at=created_at,
        expires_at=expires_at or created_at + timedelta(days=1),
        used_at=used_at,
        revoked_at=revoked_at,
    )
    session.add(token)
    session.flush()
    return token


def test_migration_creates_task_005_tables_without_premature_extended_tables(
    postgresql_engine,
) -> None:
    table_names = set(inspect(postgresql_engine).get_table_names(schema="public"))

    assert table_names >= EXPECTED_MODEL_TABLES
    assert not {"staff_profiles", "staff_permissions", "subgroups"} & table_names


def test_postgresql_ids_are_bigint_by_default_identity(postgresql_engine) -> None:
    with postgresql_engine.connect() as connection:
        columns = connection.execute(
            text(
                """
                SELECT table_name, data_type, is_identity, identity_generation
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = ANY(:model_tables)
                  AND column_name = 'id'
                """
            ),
            {"model_tables": list(EXPECTED_MODEL_TABLES)},
        ).all()

    assert {row.table_name for row in columns} == EXPECTED_MODEL_TABLES
    assert all(row.data_type == "bigint" for row in columns)
    assert all(row.is_identity == "YES" for row in columns)
    assert all(row.identity_generation == "BY DEFAULT" for row in columns)


def test_postgresql_required_columns_and_foreign_keys_match_the_models(postgresql_engine) -> None:
    inspector = inspect(postgresql_engine)
    for table_name, required_columns in REQUIRED_COLUMNS.items():
        nullable = {
            column["name"]: column["nullable"]
            for column in inspector.get_columns(table_name, schema="public")
        }
        assert all(nullable[column] is False for column in required_columns)

    for table_name, expected_keys in EXPECTED_FOREIGN_KEYS.items():
        actual_keys = {
            (
                foreign_key["constrained_columns"][0],
                foreign_key["referred_table"],
                foreign_key["referred_columns"][0],
            )
            for foreign_key in inspector.get_foreign_keys(table_name, schema="public")
        }
        assert actual_keys == expected_keys

    notification_columns = {
        column["name"]: column["nullable"]
        for column in inspector.get_columns("notifications", schema="public")
    }
    assert all(
        notification_columns[column] is True for column in ("entity_type", "entity_id", "read_at")
    )


def test_users_reject_duplicate_login(db_session) -> None:
    add_user(db_session)
    duplicate = User(
        login="student.one",
        password_hash=FIXTURE_PASSWORD_HASH,
        full_name="Another Test User",
        role="student",
        is_active=True,
    )
    db_session.add(duplicate)

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_users_login"


@pytest.mark.parametrize("role", ["student", "teacher", "staff", "admin"])
def test_users_accept_supported_roles(db_session, role: str) -> None:
    user = add_user(db_session, login=f"user-{role}", role=role)

    assert user.role == role


def test_users_reject_unsupported_role(db_session) -> None:
    db_session.add(
        User(
            login="user-invalid-role",
            password_hash=FIXTURE_PASSWORD_HASH,
            full_name="Test User",
            role="unknown",
            is_active=True,
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_users_role"


def test_users_require_password_hash(db_session) -> None:
    db_session.add(
        User(login="user-without-hash", full_name="Test User", role="student", is_active=True)
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.column_name == "password_hash"


@pytest.mark.parametrize("academic_status", ["enrolled", "academic_leave", "expelled", "graduated"])
def test_students_accept_supported_academic_statuses(db_session, academic_status: str) -> None:
    user = add_user(db_session, login=f"student-{academic_status}")
    group = add_study_group(db_session, academic_status)
    student = Student(user_id=user.id, group_id=group.id, academic_status=academic_status)
    db_session.add(student)
    db_session.flush()

    assert student.academic_status == academic_status


def test_students_reject_unsupported_academic_status(db_session) -> None:
    user = add_user(db_session)
    group = add_study_group(db_session, "invalid-status")
    db_session.add(Student(user_id=user.id, group_id=group.id, academic_status="transferred"))

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_students_academic_status"


def test_students_reject_a_second_profile_for_the_same_user(db_session) -> None:
    user = add_user(db_session)
    group = add_study_group(db_session, "duplicate-profile")
    db_session.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))
    db_session.flush()
    db_session.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_students_user_id"


def test_students_reject_nonexistent_group_foreign_key(db_session) -> None:
    user = add_user(db_session)
    db_session.add(
        Student(
            user_id=user.id,
            group_id=8_000_000_000_000_000_000,
            academic_status="enrolled",
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "fk_students_group_id_study_groups"


def test_two_users_have_independent_student_program_and_group_records(db_session) -> None:
    first_user = add_user(db_session, "student.alpha", is_active=False)
    second_user = add_user(db_session, "student.beta")
    first_group = add_study_group(db_session, "alpha")
    second_group = add_study_group(db_session, "beta")
    first_student = Student(
        user_id=first_user.id,
        group_id=first_group.id,
        academic_status="enrolled",
    )
    second_student = Student(
        user_id=second_user.id,
        group_id=second_group.id,
        academic_status="academic_leave",
    )
    db_session.add_all([first_student, second_student])
    db_session.flush()

    assert first_student.user_id != second_student.user_id
    assert first_student.group_id != second_student.group_id
    assert first_group.program_id != second_group.program_id
    assert first_user.is_active is False
    assert first_student.academic_status == "enrolled"
    assert second_student.academic_status == "academic_leave"


@pytest.mark.parametrize("org_unit_type", ["faculty", "department", "dean_office", "accounting"])
def test_org_units_accept_documented_unit_types(db_session, org_unit_type: str) -> None:
    unit = OrgUnit(name=f"Unit {org_unit_type}", type=org_unit_type)
    db_session.add(unit)
    db_session.flush()

    assert unit.type == org_unit_type


def test_org_units_reject_unsupported_unit_type(db_session) -> None:
    db_session.add(OrgUnit(name="Unsupported Unit", type="unknown"))

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_org_units_type"


def test_study_groups_reject_non_positive_course_numbers(db_session) -> None:
    group = add_study_group(db_session, "invalid-course")
    group.course_number = 0

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_study_groups_course_number"


def test_teacher_can_exist_without_account_or_department(db_session) -> None:
    teacher = Teacher(full_name="Test Lecturer", user_id=None, department_id=None)
    db_session.add(teacher)
    db_session.flush()

    assert teacher.user_id is None
    assert teacher.department_id is None


def test_teacher_account_link_is_unique_when_present(db_session) -> None:
    user = add_user(db_session, login="teacher.account", role="teacher")
    db_session.add(Teacher(full_name="First Lecturer", user_id=user.id))
    db_session.flush()
    db_session.add(Teacher(full_name="Second Lecturer", user_id=user.id))

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_teachers_user_id"


@pytest.mark.parametrize("seconds", [0, -1])
def test_auth_sessions_reject_non_positive_lifetimes(db_session, seconds: int) -> None:
    user = add_user(db_session)
    created_at = datetime.now(UTC)
    db_session.add(
        AuthSession(
            user_id=user.id,
            created_at=created_at,
            expires_at=created_at + timedelta(seconds=seconds),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_auth_sessions_expiry"


@pytest.mark.parametrize("timestamp_field", ["last_used_at", "revoked_at"])
def test_auth_sessions_reject_activity_before_creation(db_session, timestamp_field: str) -> None:
    user = add_user(db_session)
    created_at = datetime.now(UTC)
    auth_session = AuthSession(
        user_id=user.id,
        created_at=created_at,
        expires_at=created_at + timedelta(days=1),
    )
    setattr(auth_session, timestamp_field, created_at - timedelta(seconds=1))
    db_session.add(auth_session)

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == f"ck_auth_sessions_{timestamp_field}"


@pytest.mark.parametrize("seconds", [0, -1])
def test_refresh_tokens_reject_non_positive_lifetimes(db_session, seconds: int) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    db_session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=bytes(range(32)),
            created_at=created_at,
            expires_at=created_at + timedelta(seconds=seconds),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_refresh_tokens_expiry"


def test_refresh_tokens_require_32_byte_sha256_hash(db_session) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    db_session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=bytes(range(31)),
            created_at=created_at,
            expires_at=created_at + timedelta(days=1),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_refresh_tokens_token_hash_sha256_length"


@pytest.mark.parametrize("timestamp_field", ["used_at", "revoked_at"])
def test_refresh_tokens_reject_activity_before_creation(db_session, timestamp_field: str) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    token = RefreshToken(
        session_id=auth_session.id,
        token_hash=bytes(range(32)),
        created_at=created_at,
        expires_at=created_at + timedelta(days=1),
    )
    setattr(token, timestamp_field, created_at - timedelta(seconds=1))
    db_session.add(token)

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == f"ck_refresh_tokens_{timestamp_field}"


def test_refresh_token_hash_is_unique(db_session) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    add_refresh_token(
        db_session,
        auth_session,
        bytes(range(32)),
        created_at=created_at,
        used_at=created_at + timedelta(seconds=1),
    )
    db_session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=bytes(range(32)),
            created_at=created_at + timedelta(seconds=2),
            expires_at=created_at + timedelta(days=1),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_refresh_tokens_token_hash"


def test_refresh_token_parent_is_unique_for_non_null_links(db_session) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    parent = add_refresh_token(
        db_session,
        auth_session,
        bytes(range(32)),
        created_at=created_at,
        used_at=created_at + timedelta(seconds=1),
    )
    add_refresh_token(
        db_session,
        auth_session,
        bytes(range(1, 33)),
        parent_token_id=parent.id,
        created_at=created_at + timedelta(seconds=2),
        used_at=created_at + timedelta(seconds=3),
    )
    db_session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=bytes(range(2, 34)),
            parent_token_id=parent.id,
            created_at=created_at + timedelta(seconds=4),
            expires_at=created_at + timedelta(days=1),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_refresh_tokens_parent_token_id"


def test_refresh_token_cannot_reference_itself(db_session) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    token_id = 8_000_000_000_000_000_000
    created_at = datetime.now(UTC)
    db_session.add(
        RefreshToken(
            id=token_id,
            session_id=auth_session.id,
            token_hash=bytes(range(32)),
            parent_token_id=token_id,
            created_at=created_at,
            expires_at=created_at + timedelta(days=1),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "ck_refresh_tokens_parent_not_self"


def test_session_allows_at_most_one_unused_unrevoked_refresh_token(db_session) -> None:
    auth_session = add_auth_session(db_session, add_user(db_session))
    created_at = datetime.now(UTC)
    add_refresh_token(db_session, auth_session, bytes(range(32)), created_at=created_at)
    db_session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=bytes(range(1, 33)),
            created_at=created_at + timedelta(seconds=1),
            expires_at=created_at + timedelta(days=1),
        )
    )

    with pytest.raises(IntegrityError) as error:
        db_session.flush()

    assert error.value.orig.diag.constraint_name == "uq_refresh_tokens_one_active_per_session"


def test_session_foreign_key_prevents_deleting_user_with_sessions(db_session) -> None:
    user = add_user(db_session)
    add_auth_session(db_session, user)
    db_session.delete(user)

    with pytest.raises(IntegrityError):
        db_session.flush()
