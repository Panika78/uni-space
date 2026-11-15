"""Internal academic membership change; no student transfer API."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Student, StudyGroup, Subgroup


def update_student_group(
    db: Session, student_id: int, group_id: int, subgroup_id: int | None = None
) -> Student:
    """Set both membership fields in one UPDATE in the caller's transaction.

    An omitted subgroup clears the previous distribution. Validation happens
    before mutation; PostgreSQL composite FK also protects direct SQL writers.
    """
    student = db.scalars(
        select(Student)
        .where(Student.id == student_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    if db.get(StudyGroup, group_id) is None:
        raise ValueError("Unknown study group")
    if subgroup_id is not None:
        subgroup = db.get(Subgroup, subgroup_id)
        if subgroup is None or subgroup.group_id != group_id:
            raise ValueError("Subgroup does not belong to student group")
    student.group_id = group_id
    student.subgroup_id = subgroup_id
    db.flush()
    return student
