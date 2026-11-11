from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.pagination import InvalidCursorError
from app.core.schemas import ApiError, Id
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models.university import Student
from app.news.schemas import News as NewsResponse
from app.news.schemas import NewsPage
from app.news.service import get_published_news, list_published_news

router = APIRouter(
    prefix="/api/v1/news",
    tags=["news"],
    dependencies=[Depends(get_current_student)],
    responses={
        401: {"model": ApiError},
        403: {"model": ApiError},
        404: {"model": ApiError},
        422: {"model": ApiError},
        500: {"model": ApiError},
    },
)


def validate_news_query(request: Request) -> None:
    params = request.query_params
    if set(params.keys()) - {"limit", "cursor"} or any(
        len(params.getlist(name)) != 1 for name in params
    ):
        raise HTTPException(422, "validation_error")


def validate_news_detail_query(request: Request) -> None:
    if request.query_params:
        raise HTTPException(422, "validation_error")


@router.get("", response_model=NewsPage)
def list_news(
    _student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
    _validated_query: Annotated[None, Depends(validate_news_query)] = None,
) -> NewsPage:
    try:
        return list_published_news(db, limit=limit, cursor=cursor)
    except InvalidCursorError as exc:
        raise HTTPException(422, "validation_error") from exc


@router.get("/{id}", response_model=NewsResponse)
def get_news(
    id: Id,
    _student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _validated_query: Annotated[None, Depends(validate_news_detail_query)] = None,
) -> NewsResponse:
    if len(id) > 19:
        raise HTTPException(422, "validation_error")
    news_id = int(id)
    if news_id > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    result = get_published_news(db, news_id)
    if result is None:
        raise HTTPException(404, "not_found")
    return result
