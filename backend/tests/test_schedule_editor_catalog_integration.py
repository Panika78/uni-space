"""Catalog metadata must be bounded by the page, without warm identity-map caches."""

from datetime import date

import pytest
from sqlalchemy import event
from test_schedule_editor_integration import editor  # noqa: F401
from test_schedule_integration import schedule  # noqa: F401

from app.models import AcademicTerm, Building, CourseGroup, CourseOffering, Discipline, Room

pytestmark = pytest.mark.integration


@pytest.fixture(params=["course-offerings", "rooms"])
def catalog(editor, request):  # noqa: F811
    e = editor
    kind = request.param
    expected = {}
    group_ids = [group.id for group in e.groups]
    discipline = e.add(Discipline, name="NEW-01 course") if kind == "course-offerings" else None
    for index in range(101):
        if kind == "course-offerings":
            term = e.add(
                AcademicTerm,
                name=f"NEW-01 term {index}",
                starts_on=date(2026, 9, 1),
                ends_on=date(2027, 1, 31),
            )
            row = e.add(
                CourseOffering,
                discipline_id=discipline.id,
                term_id=term.id,
                attestation_type="exam",
            )
            assigned = group_ids[: index % 3]
            # Insert the links in reverse order; the public list must stay sorted.
            for group_id in reversed(assigned):
                e.add(CourseGroup, course_offering_id=row.id, group_id=group_id)
            expected[str(row.id)] = {
                "name": discipline.name,
                "term_id": str(term.id),
                "term_name": term.name,
                "group_ids": [str(i) for i in assigned],
            }
        else:
            building = e.add(Building, name=f"NEW-01 building {index}")
            row = e.add(Room, name=f"NEW-01 room {index}", building_id=building.id)
            expected[str(row.id)] = {
                "name": row.name,
                "building_id": str(building.id),
                "building_name": building.name,
                "group_ids": [],
            }
    e.db.commit()
    return e, kind, expected


def test_catalog_queries_are_constant_for_one_and_one_hundred_rows(catalog):
    e, kind, expected = catalog
    path = "/catalog/" + kind
    queries = []
    counts = []

    def count(_connection, _cursor, statement, _parameters, _context, _executemany):
        queries.append(statement)

    for limit in (1, 100):
        # Authentication and metadata must both work with a cold identity map.
        # Establish the test savepoint before counting application SQL.
        e.db.connection()
        e.db.expunge_all()
        queries.clear()
        event.listen(e.db.bind, "before_cursor_execute", count)
        try:
            response = e.request_editor("GET", path, params={"q": "NEW-01", "limit": limit})
        finally:
            event.remove(e.db.bind, "before_cursor_execute", count)
        assert response.status_code == 200, response.text
        page = response.json()
        assert [item["id"] for item in page["items"]] == list(expected)[:limit]
        for item in page["items"]:
            assert {key: item[key] for key in expected[item["id"]]} == expected[item["id"]]
        assert page["next_after_id"] == list(expected)[limit - 1]
        counts.append(len(queries))
    print(f"NEW-01 {kind}: HTTP SQL counts for limits 1/100: {counts}")
    assert counts[0] == counts[1]

    # The extra lookahead row is returned exactly once on the next page.
    tail = e.request_editor(
        "GET", path, params={"q": "NEW-01", "limit": 100, "after_id": page["next_after_id"]}
    ).json()
    assert [item["id"] for item in tail["items"]] == list(expected)[100:]
    assert tail["next_after_id"] is None
    for item in tail["items"]:
        assert {key: item[key] for key in expected[item["id"]]} == expected[item["id"]]


def test_catalog_filters_preserve_metadata_and_full_group_composition(catalog):
    e, kind, expected = catalog
    if kind == "course-offerings":
        group_id = next(item["group_ids"][0] for item in expected.values() if item["group_ids"])
        selected = [key for key, item in expected.items() if group_id in item["group_ids"]]
        params = {"q": "NEW-01 course", "group_id": group_id, "limit": 100}
    else:
        selected = [key for key, item in expected.items() if "room 10" in item["name"]]
        params = {"q": "NEW-01 room 10", "limit": 100}
        assert (
            e.request_editor("GET", "/catalog/rooms", params={"group_id": "1"}).status_code == 422
        )
    result = e.request_editor("GET", "/catalog/" + kind, params=params)
    assert result.status_code == 200, result.text
    assert [item["id"] for item in result.json()["items"]] == selected
    for item in result.json()["items"]:
        assert {key: item[key] for key in expected[item["id"]]} == expected[item["id"]]
    assert result.json()["next_after_id"] is None
    assert e.request_editor(
        "GET", "/catalog/" + kind, params={"q": "no-such-catalog-record"}
    ).json() == {"items": [], "next_after_id": None}
