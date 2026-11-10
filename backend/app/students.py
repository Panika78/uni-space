from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, Id, Ref, RequestModel
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import OrgUnit, Program, Student, StudyGroup, User

router = APIRouter(
    prefix="/api/v1/users",
    tags=["students"],
    responses={code: {"model": ApiError} for code in (401, 403, 422, 500)},
)


class ProgramRef(Ref):
    code: str


class Direction(RequestModel):
    code: str
    name: str


class StudentProfile(RequestModel):
    id: Id
    student_id: Id
    login: str
    full_name: str
    faculty: Ref
    program: ProgramRef
    direction: Direction
    group: Ref
    course_number: int
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]


@router.get("/me", response_model=StudentProfile)
def get_student_profile(
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StudentProfile:
    row = db.execute(
        select(User, StudyGroup, Program, OrgUnit)
        .select_from(Student)
        .join(User, User.id == Student.user_id)
        .join(StudyGroup, StudyGroup.id == Student.group_id)
        .join(Program, Program.id == StudyGroup.program_id)
        .join(OrgUnit, OrgUnit.id == Program.faculty_id)
        .where(Student.id == student.id)
    ).one_or_none()
    if row is None:
        raise HTTPException(403, "forbidden")
    user, group, program, faculty = row
    return StudentProfile(
        id=str(user.id),
        student_id=str(student.id),
        login=user.login,
        full_name=user.full_name,
        faculty=Ref(id=str(faculty.id), name=faculty.name),
        program=ProgramRef(id=str(program.id), code=program.code, name=program.name),
        direction=Direction(code=program.direction_code, name=program.direction_name),
        group=Ref(id=str(group.id), name=group.name),
        course_number=group.course_number,
        academic_status=student.academic_status,
    )
