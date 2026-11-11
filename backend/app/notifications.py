from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import ConfigDict
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.core.pagination import decode_page_cursor, paginate_results
from app.core.schemas import ApiError, DateTime, Id, Page, PaginationParams, RequestModel
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Notification, Student


class NotificationResponse(RequestModel):
    model_config = ConfigDict(from_attributes=True)

    id: Id
    type: str
    title: str
    body: str
    created_at: DateTime


class NotificationPage(Page[NotificationResponse]):
    pass


router = APIRouter(
    prefix="/api/v1/notifications",
    tags=["notifications"],
    responses={401: {"model": ApiError}, 403: {"model": ApiError}, 422: {"model": ApiError}},
)


@router.get("", response_model=NotificationPage)
def list_notifications(
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
) -> NotificationPage:
    limit = pagination.limit
    boundary = decode_page_cursor(pagination.cursor, key_types=(str, int), direction="desc")
    statement = select(Notification).where(Notification.user_id == student.user_id)
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
