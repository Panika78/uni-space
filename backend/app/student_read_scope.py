from fastapi import HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Student

STUDENT_SCOPE_HEADERS = {
    "Cache-Control": {"schema": {"type": "string"}},
    "X-Student-Scope": {"schema": {"type": "string"}},
}


def set_student_scope(db: Session, response: Response, student: Student) -> None:
    # Do not return a previous scope if membership changed during a multi-query read.
    current = db.execute(
        select(Student.group_id, Student.subgroup_id, Student.membership_version).where(
            Student.id == student.id
        )
    ).one_or_none()
    if current != (student.group_id, student.subgroup_id, student.membership_version):
        raise HTTPException(403, "forbidden")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Student-Scope"] = (
        f"{student.group_id}:{student.subgroup_id or 0}:{student.membership_version}"
    )
