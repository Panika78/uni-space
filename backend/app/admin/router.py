from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin import service
from app.admin.schemas import (
    AdminId,
    CreatedUser,
    CreateUser,
    LookupItem,
    LookupPage,
    LookupParams,
    PermissionGrant,
    SetActive,
    SetDepartment,
    UserDetail,
    UserListParams,
    UserPage,
)
from app.core.schemas import ApiError
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import OrgUnit, Program, StudyGroup, Teacher, User

Db = Annotated[Session, Depends(get_db_session)]
Actor = Annotated[User, Depends(get_current_user)]
router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 500)},
)


def parse_id(value: str) -> int:
    if int(value) > 9223372036854775807:
        raise HTTPException(422, "validation_error")
    return int(value)


@router.get("/users", response_model=UserPage)
def list_users(db: Db, actor: Actor, params: Annotated[UserListParams, Query()]):
    service.require_admin(db, actor)
    query = service.search_users(select(User), params.q)
    if params.after_id:
        query = query.where(User.id > parse_id(params.after_id))
    users = list(db.scalars(query.order_by(User.id).limit(params.limit + 1)))
    return UserPage(
        items=[service.summarize_user(u) for u in users[: params.limit]],
        next_after_id=str(users[params.limit - 1].id) if len(users) > params.limit else None,
    )


@router.get("/lookups", response_model=LookupPage)
def list_profile_options(db: Db, actor: Actor, params: Annotated[LookupParams, Query()]):
    service.require_admin(db, actor)
    model = {"groups": StudyGroup, "teachers": Teacher, "org_units": OrgUnit}[params.kind]
    name = Teacher.full_name if model is Teacher else model.name
    query = select(model)
    if model is Teacher:
        query = query.where(Teacher.user_id.is_(None))
    if params.q:
        query = query.where(name.icontains(params.q, autoescape=True))
    if params.after_id:
        query = query.where(model.id > parse_id(params.after_id))
    rows = list(db.scalars(query.order_by(model.id).limit(params.limit + 1)))
    # Bounded context reads preserve pagination and distinguish identically named records.
    visible = rows[: params.limit]
    unit_ids = (
        {row.department_id if model is Teacher else row.parent_id for row in visible}
        if model in (Teacher, OrgUnit)
        else set()
    )
    units = {unit.id: unit for unit in db.scalars(select(OrgUnit).where(OrgUnit.id.in_(unit_ids)))}
    programs = (
        {
            program.id: program
            for program in db.scalars(
                select(Program).where(Program.id.in_({row.program_id for row in visible}))
            )
        }
        if model is StudyGroup
        else {}
    )

    def get_context(row):
        if model is StudyGroup:
            program = programs[row.program_id]
            return (
                f"Программа {program.code}: {program.name} (ID {program.id}); "
                f"курс {row.course_number}"
            )
        parent = units.get(row.department_id if model is Teacher else row.parent_id)
        if parent:
            label = "Кафедра" if model is Teacher else "Родительское подразделение"
            return f"{label}: {parent.name} (ID {parent.id})"
        return None

    return LookupPage(
        items=[
            LookupItem(
                id=str(row.id),
                name=row.full_name if model is Teacher else row.name,
                type=row.type if model is OrgUnit else None,
                context=get_context(row),
            )
            for row in rows[: params.limit]
        ],
        next_after_id=str(rows[params.limit - 1].id) if len(rows) > params.limit else None,
    )


@router.get("/users/{user_id}", response_model=UserDetail)
def get_user(user_id: AdminId, db: Db, actor: Actor):
    service.require_admin(db, actor)
    return service.get_user_detail(db, service.get_user(db, parse_id(user_id)))


def commit_change(db: Session, operation):
    try:
        user = operation()
        result = service.get_user_detail(db, user)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "conflict") from None
    except Exception:
        db.rollback()
        raise


@router.post("/users", response_model=CreatedUser, status_code=201)
def create_user(data: CreateUser, db: Db, actor: Actor):
    # The response secret is never passed to a query cache or persisted for replay.
    password = None

    def create():
        nonlocal password
        user, password = service.create_user(db, actor, data)
        return user

    result = commit_change(db, create)
    return CreatedUser(user=result, initial_password=password)


@router.put("/users/{user_id}/active", response_model=UserDetail)
def set_active(user_id: AdminId, data: SetActive, db: Db, actor: Actor):
    return commit_change(
        db, lambda: service.set_user_active(db, actor, parse_id(user_id), data.is_active)
    )


@router.put("/users/{user_id}/department", response_model=UserDetail)
def set_department(user_id: AdminId, data: SetDepartment, db: Db, actor: Actor):
    return commit_change(
        db,
        lambda: service.set_staff_department(
            db, actor, parse_id(user_id), parse_id(data.org_unit_id)
        ),
    )


@router.put("/users/{user_id}/permissions", response_model=UserDetail)
def grant_permission(user_id: AdminId, data: PermissionGrant, db: Db, actor: Actor):
    return commit_change(
        db, lambda: service.set_staff_permission(db, actor, parse_id(user_id), data, grant=True)
    )


@router.delete("/users/{user_id}/permissions", response_model=UserDetail)
def revoke_permission(user_id: AdminId, data: PermissionGrant, db: Db, actor: Actor):
    return commit_change(
        db, lambda: service.set_staff_permission(db, actor, parse_id(user_id), data, grant=False)
    )
