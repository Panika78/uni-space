from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.pagination import InvalidCursorError
from app.core.schemas import ApiError, Id, PaginationParams
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import News, User
from app.news.schemas import NewsContent, NewsUpdate, StaffNews, StaffNewsPage
from app.news.service import (
    IdempotencyConflict,
    NewsVersionConflict,
    create_staff_news,
    get_staff_news,
    list_staff_news,
    serialize_staff_news,
    set_news_publication,
    update_staff_news,
)
from app.permissions import PermissionCode, get_authorization_context, require_staff_permission

router = APIRouter(prefix="/api/v1/staff/news", tags=["staff-news"])
ERRORS = {code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 500)}


def require_news_publisher(db: Session, user: User) -> None:
    context = get_authorization_context(db, user)
    if context.role != "staff" or context.org_unit_id is None:
        raise HTTPException(403, "forbidden")
    require_staff_permission(
        db, user, PermissionCode.NEWS_PUBLISH, org_unit_id=int(context.org_unit_id)
    )


def validate_news_query(request: Request) -> None:
    if set(request.query_params) - {"limit", "cursor"} or any(
        len(request.query_params.getlist(name)) != 1 for name in request.query_params
    ):
        raise HTTPException(422, "validation_error")


def get_existing_news(db: Session, news_id: str, *, for_update: bool = False) -> News:
    if len(news_id) > 19 or int(news_id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    item = get_staff_news(db, int(news_id), for_update=for_update)
    if item is None:
        raise HTTPException(404, "not_found")
    return item


@router.get("", response_model=StaffNewsPage, responses=ERRORS)
def list_news(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
    request: Request,
) -> StaffNewsPage:
    require_news_publisher(db, user)
    validate_news_query(request)
    try:
        return list_staff_news(db, limit=pagination.limit, cursor=pagination.cursor)
    except InvalidCursorError as exc:
        raise HTTPException(422, "validation_error") from exc


@router.get("/{id}", response_model=StaffNews, responses=ERRORS)
def get_news(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    request: Request,
) -> StaffNews:
    require_news_publisher(db, user)
    if request.query_params:
        raise HTTPException(422, "validation_error")
    return serialize_staff_news(get_existing_news(db, id))


@router.post("", response_model=StaffNews, status_code=201, responses=ERRORS)
def create_news(
    content: NewsContent,
    response: Response,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
) -> StaffNews:
    context = get_authorization_context(db, user)
    if context.role != "staff" or context.org_unit_id is None:
        raise HTTPException(403, "forbidden")
    require_staff_permission(
        db, user, PermissionCode.NEWS_PUBLISH, org_unit_id=int(context.org_unit_id)
    )
    try:
        item, replayed = create_staff_news(
            db, user, int(context.org_unit_id), content, idempotency_key
        )
    except IdempotencyConflict as exc:
        raise HTTPException(409, "idempotency_conflict") from exc
    response.headers["Location"] = f"/api/v1/staff/news/{item.id}"
    if replayed:
        response.status_code = 200
    return item


@router.patch("/{id}", response_model=StaffNews, responses=ERRORS)
def update_news(
    id: Id,
    content: NewsUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StaffNews:
    require_news_publisher(db, user)
    try:
        item = update_staff_news(db, user, get_existing_news(db, id, for_update=True), content)
    except NewsVersionConflict as exc:
        raise HTTPException(409, "version_conflict") from exc
    return serialize_staff_news(item)


@router.post("/{id}/publish", response_model=StaffNews, responses=ERRORS)
def publish_news(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StaffNews:
    require_news_publisher(db, user)
    item = set_news_publication(db, user, get_existing_news(db, id, for_update=True), publish=True)
    return serialize_staff_news(item)


@router.post("/{id}/unpublish", response_model=StaffNews, responses=ERRORS)
def unpublish_news(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StaffNews:
    require_news_publisher(db, user)
    item = set_news_publication(db, user, get_existing_news(db, id, for_update=True), publish=False)
    return serialize_staff_news(item)
