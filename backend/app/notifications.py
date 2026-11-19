from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ConfigDict, Field
from sqlalchemy import func, select, tuple_, update
from sqlalchemy.orm import Session

from app.academics.courses import require_student_course
from app.applications.service import get_owned_application
from app.core.pagination import decode_page_cursor, paginate_results
from app.core.schemas import ApiError, DateTime, Id, Page, PaginationParams, RequestModel
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import Lesson, Notification, Student, User
from app.permissions import require_application_review
from app.schedule.participants import get_student_lesson_condition
from app.schedule.service import MOSCOW


class NotificationResponse(RequestModel):
    model_config = ConfigDict(from_attributes=True)

    id: Id
    type: str
    title: str
    body: str
    created_at: DateTime
    read_at: DateTime | None
    entity_type: str | None
    entity_id: Id | None


class NotificationPage(Page[NotificationResponse]):
    pass


class NotificationUnreadCount(RequestModel):
    count: int = Field(ge=0)


class NotificationReadResponse(RequestModel):
    id: Id
    read_at: DateTime


class NotificationsReadResponse(RequestModel):
    updated_count: int = Field(ge=0)


class NotificationTargetResponse(RequestModel):
    path: str


router = APIRouter(
    prefix="/api/v1/notifications",
    tags=["notifications"],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 422, 500)},
)


def parse_notification_id(identifier: str) -> int:
    if len(identifier) > 19 or int(identifier) > 2**63 - 1:
        raise HTTPException(422, "validation_error")
    return int(identifier)


def get_owned_notification(db: Session, user: User, identifier: int) -> Notification:
    item = db.scalar(
        select(Notification)
        .where(Notification.id == identifier, Notification.user_id == user.id)
        .execution_options(populate_existing=True)
    )
    if item is None:
        raise HTTPException(404, "not_found")
    return item


@router.get("", response_model=NotificationPage)
def list_notifications(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
) -> NotificationPage:
    limit = pagination.limit
    boundary = decode_page_cursor(pagination.cursor, key_types=(str, int), direction="desc")
    statement = select(Notification).where(Notification.user_id == user.id)
    if boundary is not None:
        created_at, notification_id = boundary
        try:
            timestamp = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if timestamp.utcoffset() is None or notification_id < 1:
                raise ValueError
        except (ValueError, TypeError) as exc:
            from app.core.pagination import InvalidCursorError

            raise InvalidCursorError("Invalid notification cursor") from exc
        statement = statement.where(
            tuple_(Notification.created_at, Notification.id) < (timestamp, notification_id)
        )
    rows = db.scalars(
        statement.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)
    ).all()
    items = [
        NotificationResponse(
            id=str(item.id),
            type=item.type,
            title=item.title,
            body=item.body,
            created_at=item.created_at,
            read_at=item.read_at,
            entity_type=item.entity_type,
            entity_id=str(item.entity_id) if item.entity_id is not None else None,
        )
        for item in rows
    ]
    return paginate_results(
        items,
        key=lambda item: (item.created_at.isoformat(), int(item.id)),
        key_types=(str, int),
        direction="desc",
        limit=limit,
    )


@router.get("/unread-count", response_model=NotificationUnreadCount)
def get_notification_unread_count(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> NotificationUnreadCount:
    count = db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
    )
    return NotificationUnreadCount(count=count)


async def require_empty_notification_body(
    request: Request,
    _user: Annotated[User, Depends(get_current_user)],
) -> None:
    async for chunk in request.stream():
        if chunk:
            raise HTTPException(422, "validation_error")


@router.post(
    "/read-all",
    response_model=NotificationsReadResponse,
    dependencies=[Depends(require_empty_notification_body)],
)
def mark_all_notifications_read(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> NotificationsReadResponse:
    # PostgreSQL rechecks the NULL predicate after concurrent row-lock waits.
    # A single statement provides an atomic snapshot and preserves previous marks.
    changed = db.scalars(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=func.clock_timestamp())
        .returning(Notification.id)
        .execution_options(synchronize_session=False)
    ).all()
    db.commit()
    return NotificationsReadResponse(updated_count=len(changed))


@router.patch(
    "/{id}/read",
    response_model=NotificationReadResponse,
    dependencies=[Depends(require_empty_notification_body)],
)
def mark_notification_read(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> NotificationReadResponse:
    identifier = parse_notification_id(id)
    read_at = db.scalar(
        update(Notification)
        .where(
            Notification.id == identifier,
            Notification.user_id == user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.clock_timestamp())
        .returning(Notification.read_at)
        .execution_options(synchronize_session=False)
    )
    if read_at is None:
        read_at = get_owned_notification(db, user, identifier).read_at
    db.commit()
    return NotificationReadResponse(id=id, read_at=read_at)


def resolve_notification_target(db: Session, user: User, item: Notification) -> str:
    if item.entity_id is None or item.entity_id < 1:
        raise HTTPException(404, "not_found")
    identifier = item.entity_id
    if item.entity_type not in {"application", "course_offering", "lesson"}:
        raise HTTPException(404, "not_found")
    if user.role == "staff" and item.entity_type == "application":
        try:
            require_application_review(db, user, identifier)
        except HTTPException as exc:
            if exc.status_code in {403, 404}:
                raise HTTPException(404, "not_found") from exc
            raise
        return f"/staff/applications/{identifier}"
    # Other roles have no working routes for these objects in this release.
    if user.role != "student":
        raise HTTPException(404, "not_found")
    student = db.scalar(select(Student).where(Student.user_id == user.id))
    if student is None:
        raise HTTPException(404, "not_found")
    if item.entity_type == "application":
        get_owned_application(db, student, identifier)
        return f"/applications/{identifier}"
    if item.entity_type == "course_offering":
        require_student_course(db, student, identifier)
        return f"/academics/courses/{identifier}"
    lesson = db.scalar(
        select(Lesson).where(
            Lesson.id == identifier,
            get_student_lesson_condition(Lesson.id, student.group_id, student.subgroup_id),
        )
    )
    if lesson is None:
        raise HTTPException(404, "not_found")
    date = lesson.starts_at.astimezone(MOSCOW).date().isoformat()
    return f"/schedule?date={date}&mode=day&lesson_id={identifier}"


@router.get("/{id}/target", response_model=NotificationTargetResponse)
def get_notification_target(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> NotificationTargetResponse:
    item = get_owned_notification(db, user, parse_notification_id(id))
    return NotificationTargetResponse(path=resolve_notification_target(db, user, item))
