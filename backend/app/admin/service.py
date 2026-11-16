"""Administrator operations. Caller owns one transaction including mandatory audit."""

import secrets
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.admin.schemas import CreateUser, PermissionGrant, UserDetail, UserSummary
from app.audit import write_audit_event
from app.auth.security import PASSWORD_HASHER
from app.auth.service import revoke_session
from app.models import (
    AuthSession,
    OrgUnit,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    Teacher,
    User,
)
from app.permissions import ACADEMIC_PERMISSIONS, PermissionCode

# All administrator writes (including bootstrap) serialize before any user row lock.
# Re-read the actor after waiting: two administrators cannot disable each other.
ADMIN_LOCK = 7825001


def lock_administration(db: Session) -> None:
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADMIN_LOCK})


def require_admin(db: Session, actor: User, *, write: bool = False) -> User:
    actor_id = actor.id
    if write:
        lock_administration(db)
    current = db.scalar(
        select(User).where(User.id == actor_id).execution_options(populate_existing=True)
    )
    if current is None or not current.is_active or current.role != "admin":
        raise HTTPException(403, "forbidden")
    return current


def get_user(db: Session, user_id: int, *, lock: bool = False) -> User:
    query = select(User).where(User.id == user_id)
    if lock:
        query = query.with_for_update()
    user = db.scalar(query.execution_options(populate_existing=True))
    if user is None:
        raise HTTPException(404, "not_found")
    return user


def summarize_user(user: User) -> UserSummary:
    return UserSummary(
        id=str(user.id),
        login=user.login,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
    )


def get_user_detail(db: Session, user: User) -> UserDetail:
    student = db.scalar(select(Student).where(Student.user_id == user.id))
    teacher = db.scalar(select(Teacher).where(Teacher.user_id == user.id))
    staff = db.scalar(select(StaffProfile).where(StaffProfile.user_id == user.id))
    grants = (
        list(
            db.scalars(
                select(StaffPermission)
                .where(StaffPermission.staff_profile_id == staff.id)
                .order_by(StaffPermission.id)
            )
        )
        if staff
        else []
    )
    unit = db.get(OrgUnit, staff.org_unit_id) if staff else None
    return UserDetail(
        **summarize_user(user).model_dump(),
        student_id=str(student.id) if student else None,
        group_id=str(student.group_id) if student else None,
        teacher_id=str(teacher.id) if teacher else None,
        staff_profile_id=str(staff.id) if staff else None,
        org_unit_id=str(staff.org_unit_id) if staff else None,
        available_permission_codes=[
            code
            for code in PermissionCode
            if unit and (unit.type == "dean_office" or code not in ACADEMIC_PERMISSIONS)
        ],
        permissions=[
            PermissionGrant(
                permission_code=g.permission_code,
                scope_org_unit_id=str(g.scope_org_unit_id) if g.scope_org_unit_id else None,
            )
            for g in grants
        ],
    )


def audit_change(db, actor, entity, action, before, after, *, entity_type=None):
    write_audit_event(
        db,
        actor=actor,
        entity_type=entity_type or entity.__tablename__.removesuffix("s"),
        entity_id=entity.id,
        action=action,
        before_data=before,
        after_data=after,
        reason="administrative_change",
    )


def create_user(db: Session, actor: User, data: CreateUser) -> tuple[User, str]:
    require_admin(db, actor, write=True)
    if db.scalar(select(User.id).where(User.login == data.login)):
        raise HTTPException(409, "login_exists")
    teacher = None
    if data.role == "teacher":
        teacher = db.scalar(
            select(Teacher)
            .where(Teacher.id == int(data.teacher_id))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if teacher is None or teacher.user_id is not None:
            raise HTTPException(409, "teacher_unavailable")
    if data.role == "student" and db.get(StudyGroup, int(data.group_id)) is None:
        raise HTTPException(422, "invalid_profile")
    if data.role == "staff" and db.get(OrgUnit, int(data.org_unit_id)) is None:
        raise HTTPException(422, "invalid_profile")
    password = secrets.token_urlsafe(24)
    user = User(
        login=data.login,
        full_name=teacher.full_name if teacher else data.full_name,
        role=data.role,
        is_active=True,
        password_hash=PASSWORD_HASHER.hash(password),
    )
    db.add(user)
    db.flush()
    audit_change(db, actor, user, "create", None, {"role": user.role, "is_active": True})
    if data.role == "student":
        profile = Student(user_id=user.id, group_id=int(data.group_id), academic_status="enrolled")
        db.add(profile)
        db.flush()
        audit_change(
            db,
            actor,
            profile,
            "create",
            None,
            {"user_id": user.id, "group_id": profile.group_id, "academic_status": "enrolled"},
        )
    elif teacher:
        teacher.user_id = user.id
        audit_change(db, actor, teacher, "link_user", {"user_id": None}, {"user_id": user.id})
    elif data.role == "staff":
        profile = StaffProfile(user_id=user.id, org_unit_id=int(data.org_unit_id))
        db.add(profile)
        db.flush()
        audit_change(
            db,
            actor,
            profile,
            "create",
            None,
            {"user_id": user.id, "org_unit_id": profile.org_unit_id},
            entity_type="staff_profile",
        )
    return user, password


def set_user_active(db: Session, actor: User, user_id: int, active: bool) -> User:
    require_admin(db, actor, write=True)
    user = get_user(db, user_id, lock=True)
    if not active and user.id == actor.id:
        raise HTTPException(409, "self_block_forbidden")
    if user.is_active == active:
        return user
    if not active and user.role == "admin":
        others = db.scalar(
            select(User.id).where(User.role == "admin", User.is_active, User.id != user.id).limit(1)
        )
        if others is None:
            raise HTTPException(409, "last_admin")
    before = {"is_active": user.is_active}
    user.is_active = active
    if not active:
        sessions = db.scalars(
            select(AuthSession)
            .where(AuthSession.user_id == user.id)
            .order_by(AuthSession.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        now = datetime.now(UTC)
        for session in sessions:
            revoke_session(db, session, now, "user_blocked")
    audit_change(db, actor, user, "set_active", before, {"is_active": active})
    return user


def get_staff(db: Session, user_id: int) -> StaffProfile:
    user = get_user(db, user_id, lock=True)
    profile = db.scalar(
        select(StaffProfile).where(StaffProfile.user_id == user.id).with_for_update()
    )
    if user.role != "staff" or profile is None:
        raise HTTPException(404, "not_found")
    return profile


def grant_snapshot(grant: StaffPermission) -> dict:
    return {
        "staff_profile_id": grant.staff_profile_id,
        "permission_code": grant.permission_code,
        "scope_org_unit_id": grant.scope_org_unit_id,
    }


def revoke_grant(db: Session, actor: User, grant: StaffPermission) -> None:
    snapshot = grant_snapshot(grant)
    db.delete(grant)
    audit_change(db, actor, grant, "delete", snapshot, None, entity_type="staff_permission")


def set_staff_department(db: Session, actor: User, user_id: int, unit_id: int) -> User:
    require_admin(db, actor, write=True)
    profile = get_staff(db, user_id)
    if db.get(OrgUnit, unit_id) is None:
        raise HTTPException(422, "invalid_profile")
    if profile.org_unit_id != unit_id:
        grants = list(
            db.scalars(
                select(StaffPermission).where(StaffPermission.staff_profile_id == profile.id)
            )
        )
        for grant in grants:
            revoke_grant(db, actor, grant)
        before = {"org_unit_id": profile.org_unit_id}
        profile.org_unit_id = unit_id
        audit_change(
            db,
            actor,
            profile,
            "set_org_unit",
            before,
            {"org_unit_id": unit_id},
            entity_type="staff_profile",
        )
    return get_user(db, user_id)


def set_staff_permission(
    db: Session, actor: User, user_id: int, data: PermissionGrant, *, grant: bool
) -> User:
    require_admin(db, actor, write=True)
    profile = get_staff(db, user_id)
    unit = db.get(OrgUnit, profile.org_unit_id)
    scope = int(data.scope_org_unit_id) if data.scope_org_unit_id else None
    valid = (
        (unit.type == "dean_office" and scope is None)
        if data.permission_code in ACADEMIC_PERMISSIONS
        else scope == unit.id
    )
    if not valid:
        raise HTTPException(422, "invalid_permission_scope")
    existing = db.scalar(
        select(StaffPermission).where(
            StaffPermission.staff_profile_id == profile.id,
            StaffPermission.permission_code == data.permission_code,
            StaffPermission.scope_org_unit_id == scope,
        )
    )
    if grant and existing is None:
        existing = StaffPermission(
            staff_profile_id=profile.id,
            permission_code=data.permission_code.value,
            scope_org_unit_id=scope,
        )
        db.add(existing)
        db.flush()
        audit_change(
            db,
            actor,
            existing,
            "create",
            None,
            grant_snapshot(existing),
            entity_type="staff_permission",
        )
    elif not grant and existing is not None:
        revoke_grant(db, actor, existing)
    return get_user(db, user_id)


def search_users(query, q: str):
    if q:
        query = query.where(
            or_(
                User.login.icontains(q, autoescape=True),
                User.full_name.icontains(q, autoescape=True),
            )
        )
    return query
