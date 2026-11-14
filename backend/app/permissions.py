"""Shared staff permission contract; teacher assignments belong to #61."""

from enum import StrEnum
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, Id, RequestModel
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import Application, OrgUnit, ServiceType, StaffPermission, StaffProfile, User


class PermissionCode(StrEnum):
    SCHEDULE_EDIT = "schedule.edit"
    GRADES_EDIT = "grades.edit"
    ATTENDANCE_EDIT = "attendance.edit"
    STUDENTS_READ = "students.read"
    STUDENTS_EDIT = "students.edit"
    STUDENTS_STATUS_EDIT = "students.status.edit"
    GROUPS_MANAGE = "groups.manage"
    APPLICATIONS_REVIEW = "applications.review"
    NEWS_PUBLISH = "news.publish"


ACADEMIC_PERMISSIONS = frozenset(PermissionCode) - {
    PermissionCode.APPLICATIONS_REVIEW,
    PermissionCode.NEWS_PUBLISH,
}


class EffectivePermission(RequestModel):
    permission_code: PermissionCode
    scope_org_unit_id: Id | None


class AuthorizationContext(RequestModel):
    user_id: Id
    role: Literal["student", "teacher", "staff", "admin"]
    org_unit_id: Id | None
    permissions: list[EffectivePermission]


def get_authorization_context(db: Session, user: User) -> AuthorizationContext:
    current = db.scalar(
        select(User).where(User.id == user.id).execution_options(populate_existing=True)
    )
    if current is None or not current.is_active:
        raise HTTPException(401, "session_invalid")
    context = AuthorizationContext(
        user_id=str(current.id), role=current.role, org_unit_id=None, permissions=[]
    )
    if current.role != "staff":
        return context
    row = db.execute(
        select(StaffProfile, OrgUnit)
        .join(OrgUnit)
        .where(StaffProfile.user_id == current.id)
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None:
        return context
    profile, unit = row
    context.org_unit_id = str(unit.id)
    grants = db.scalars(
        select(StaffPermission)
        .where(StaffPermission.staff_profile_id == profile.id)
        .order_by(StaffPermission.permission_code, StaffPermission.id)
        .execution_options(populate_existing=True)
    )
    for grant in grants:
        code = PermissionCode(grant.permission_code)
        scope = grant.scope_org_unit_id
        if code in ACADEMIC_PERMISSIONS:
            valid = unit.type == "dean_office" and scope is None
        else:
            valid = scope == unit.id
        if valid:
            context.permissions.append(
                EffectivePermission(
                    permission_code=code,
                    scope_org_unit_id=str(scope) if scope is not None else None,
                )
            )
    return context


def require_staff_permission(
    db: Session, user: User, code: PermissionCode, *, org_unit_id: int | None = None
) -> AuthorizationContext:
    code = PermissionCode(code)
    context = get_authorization_context(db, user)
    if not any(
        grant.permission_code == code
        and (
            (code in ACADEMIC_PERMISSIONS and grant.scope_org_unit_id is None)
            or (org_unit_id is not None and grant.scope_org_unit_id == str(org_unit_id))
        )
        for grant in context.permissions
    ):
        raise HTTPException(403, "forbidden")
    return context


def require_permission(code: PermissionCode):
    """Academic dependency. Object-scoped services resolve scope from DB instead."""
    code = PermissionCode(code)

    def require_current_permission(
        user: Annotated[User, Depends(get_current_user)],
        db: Annotated[Session, Depends(get_db_session)],
    ) -> User:
        require_staff_permission(db, user, code)
        return user

    return require_current_permission


def get_application_scope():
    """Shared SQL expression for object checks and future queue filtering."""
    return func.coalesce(Application.assigned_org_unit_id, ServiceType.responsible_org_unit_id)


def require_application_review(db: Session, user: User, application_id: int) -> Application:
    context = get_authorization_context(db, user)
    scopes = [
        int(p.scope_org_unit_id)
        for p in context.permissions
        if p.permission_code == PermissionCode.APPLICATIONS_REVIEW
        and p.scope_org_unit_id is not None
    ]
    if not scopes:
        raise HTTPException(403, "forbidden")
    application = db.scalar(
        select(Application)
        .join(ServiceType)
        .where(Application.id == application_id, get_application_scope().in_(scopes))
        .execution_options(populate_existing=True)
    )
    if application is None:
        raise HTTPException(404, "not_found")
    return application


router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
    responses={code: {"model": ApiError} for code in (401, 403, 422, 500)},
)


@router.get("/context", response_model=AuthorizationContext)
def get_current_authorization_context(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> AuthorizationContext:
    if request.query_params:
        raise RequestValidationError(
            [{"type": "extra_forbidden", "loc": ("query", name)} for name in request.query_params]
        )
    return get_authorization_context(db, user)
