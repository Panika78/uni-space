import re
from datetime import datetime

from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session

from app.core.pagination import (
    CursorKey,
    InvalidCursorError,
    decode_page_cursor,
    paginate_results,
)
from app.models.news import News
from app.news.schemas import News as NewsResponse
from app.news.schemas import NewsPage, NewsPreview

NEWS_CURSOR_TYPES = (str, int)
EXCERPT_LENGTH = 180


def create_excerpt(body: str) -> str:
    """Collapse all whitespace; cap at 180 Unicode code points, ellipsis included."""
    normalized = re.sub(r"\s+", " ", body, flags=re.UNICODE).strip()
    if len(normalized) <= EXCERPT_LENGTH:
        return normalized
    return normalized[: EXCERPT_LENGTH - 1].rstrip() + "…"


def _cursor_key(news: News) -> CursorKey:
    assert news.published_at is not None
    return news.published_at.isoformat(), news.id


def list_published_news(db: Session, *, limit: int, cursor: str | None) -> NewsPage:
    after = decode_page_cursor(cursor, key_types=NEWS_CURSOR_TYPES, direction="desc")
    statement = select(News).where(
        News.is_published.is_(True),
        News.published_at.is_not(None),
        News.published_at <= func.now(),
    )
    if after is not None:
        try:
            published_at = datetime.fromisoformat(str(after[0]))
            if published_at.utcoffset() is None or not 1 <= after[1] <= 9_223_372_036_854_775_807:
                raise ValueError
        except (ValueError, OverflowError) as exc:
            raise InvalidCursorError("Cursor does not match this selection") from exc
        statement = statement.where(tuple_(News.published_at, News.id) < (published_at, after[1]))
    rows = db.scalars(
        statement.order_by(News.published_at.desc(), News.id.desc()).limit(limit + 1)
    ).all()
    page = paginate_results(
        rows, key=_cursor_key, key_types=NEWS_CURSOR_TYPES, direction="desc", limit=limit
    )
    return NewsPage(
        items=[
            NewsPreview(
                id=str(item.id),
                title=item.title,
                excerpt=create_excerpt(item.body),
                published_at=item.published_at,
            )
            for item in page.items
        ],
        next_cursor=page.next_cursor,
    )


def get_published_news(db: Session, news_id: int) -> NewsResponse | None:
    item = db.scalar(
        select(News).where(
            News.id == news_id,
            News.is_published.is_(True),
            News.published_at.is_not(None),
            News.published_at <= func.now(),
        )
    )
    if item is None:
        return None
    return NewsResponse(
        id=str(item.id),
        title=item.title,
        excerpt=create_excerpt(item.body),
        published_at=item.published_at,
        body=item.body,
    )
