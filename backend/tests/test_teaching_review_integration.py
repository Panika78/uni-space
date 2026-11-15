"""Review regressions: validate IDs before SQL; Russian ordering end to end."""

import base64
import json
from uuid import uuid4

import pytest
from sqlalchemy import event, select, text
from test_teaching_integration import journal  # noqa: F401

from app.core.pagination import decode_page_cursor
from app.models import Student, User
from app.teaching.ordering import STUDENT_KEY_PREFIX, get_student_name_key

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "invalid",
    [
        pytest.param("0", id="zero"),
        pytest.param("-1", id="negative"),
        pytest.param("01", id="leading-zero"),
        pytest.param("9223372036854775808", id="bigint-overflow"),
        pytest.param("9" * 20, id="twenty-digits"),
        pytest.param("9" * 4301, id="python-int-conversion-limit"),
    ],
)
def test_invalid_ids_on_all_teaching_routes_are_422_before_sql(journal, invalid):  # noqa: F811
    s = journal
    base = f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
    suffixes = ["students", "assessments", "assessments/1/results", "lessons", "lessons/1/students"]
    requests = []
    for suffix in suffixes:
        for component in [f"courses/{s.courses[0].id}", f"groups/{s.groups[0].id}"]:
            field = component.split("/")[0]
            requests.append((base.replace(component, f"{field}/{invalid}") + "/" + suffix, {}))
    requests.extend(
        [
            (base + f"/assessments/{invalid}/results", {}),
            (base + f"/lessons/{invalid}/students", {}),
        ]
    )
    for route, fields in [
        ("/api/v1/teaching/assignments", ["course_offering_id", "group_id", "term_id"]),
        (base + "/students", ["student_id"]),
        (base + "/assessments", ["assessment_group_id"]),
        (base + "/assessments/1/results", ["student_id"]),
        (base + "/lessons", ["lesson_id"]),
        (base + "/lessons/1/students", ["student_id"]),
    ]:
        requests.extend((route, {field: invalid}) for field in fields)
    calls = []

    def record(*args):
        calls.append(args[2])

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        for route, params in requests:
            response = s.client.get(
                route, params=params, headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"}
            )
            assert response.status_code == 422, (route[:180], response.text[:500])
            assert response.json()["error"]["code"] == "validation_error"
        assert calls == [], "Invalid IDs must not reach auth, scope, or journal SQL"
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)


def test_maximum_bigint_id_is_valid_but_does_not_grant_scope(journal):  # noqa: F811
    s = journal
    maximum = "9223372036854775807"
    for field in ["course_offering_id", "group_id", "term_id"]:
        response = s.get("assignments", **{field: maximum})
        assert response.status_code == 200
        assert response.json()["items"] == []
    response = s.client.get(
        f"/api/v1/teaching/courses/{maximum}/groups/{s.groups[0].id}/students",
        headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
    )
    assert response.status_code == 404


def test_russian_order_matches_sql_cursor_python_and_every_results_page(journal):  # noqa: F811
    s = journal
    # Scramble insertion and case. Include every Russian letter, Е/Ё prefix
    # boundaries, identical names, and names differing only in case.
    alphabet = list("АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ")
    names = alphabet[::-1] + ["Ея", "Ёа", "ева", "Ева", "Ева", "ёж", "Ёж"]
    for name in names:
        user = s.add(
            User,
            login=uuid4().hex,
            password_hash="unused",
            full_name=name,
            role="student",
            is_active=True,
        )
        s.add(Student, user_id=user.id, group_id=s.groups[0].id, academic_status="enrolled")
    work = s.assignment(s.courses[0])
    s.result(work, 0)
    s.result(work, 7, student=2)
    # Independent explicit rank reference, not C/Python ordering of raw names.
    ranks = {letter.lower(): index for index, letter in enumerate(alphabet)}
    expected = sorted(
        s.db.execute(
            select(Student.id, User.full_name).join(User).where(Student.group_id == s.groups[0].id)
        ).all(),
        key=lambda row: (tuple(ranks.get(ch, 1000 + ord(ch)) for ch in row[1].lower()), row[0]),
    )
    expected_ids = [str(row[0]) for row in expected]
    expected_names = {str(row[0]): row[1] for row in expected}
    assert s.db.scalar(text("SHOW server_encoding")) == "UTF8"
    key = get_student_name_key(User.full_name)
    sql_rows = s.db.execute(
        select(Student.id, key)
        .join(User)
        .where(Student.group_id == s.groups[0].id)
        .order_by(key, Student.id)
    ).all()
    assert [str(row[0]) for row in sql_rows] == expected_ids
    assert [(row[1], row[0]) for row in sql_rows] == sorted((row[1], row[0]) for row in sql_rows)
    for suffix, id_field in [("students", "id"), (f"assessments/{work.id}/results", "student_id")]:
        for limit in [1, 2, 7, 100]:
            ids, cursor, previous_key = [], None, None
            while True:
                params = {"limit": limit, **({"cursor": cursor} if cursor else {})}
                response = s.get(suffix, **params)
                assert response.status_code == 200, response.text
                page = response.json()
                assert all(
                    row["full_name"] == expected_names[row[id_field]] for row in page["items"]
                )
                ids.extend(row[id_field] for row in page["items"])
                cursor = page["next_cursor"]
                if cursor is None:
                    break
                boundary = decode_page_cursor(cursor, key_types=(str, int), direction="asc")
                assert boundary[0].startswith(STUDENT_KEY_PREFIX)
                assert previous_key is None or boundary > previous_key
                assert boundary == (sql_rows[len(ids) - 1][1], int(ids[-1]))
                previous_key = boundary
            assert ids == expected_ids
            assert len(ids) == len(set(ids))
    # Old raw-name cursor is syntactically valid v2 but invalid for new ordering.
    old = (
        base64.urlsafe_b64encode(
            json.dumps({"v": 2, "direction": "asc", "key": ["Ёж", s.students[0].id]}).encode()
        )
        .decode()
        .rstrip("=")
    )
    for suffix in ["students", f"assessments/{work.id}/results"]:
        response = s.get(suffix, cursor=old)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"
