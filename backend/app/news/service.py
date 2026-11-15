import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, tuple_, update
from sqlalchemy.orm import Session

from app.audit import write_audit_event
from app.core.pagination import (
    CursorKey,
    InvalidCursorError,
    decode_page_cursor,
    paginate_results,
)
from app.models.accounts import User
from app.models.news import News
from app.news.schemas import News as NewsResponse
from app.news.schemas import NewsContent, NewsPage, NewsPreview, StaffNews, StaffNewsPage

NEWS_CURSOR_TYPES = (int, int)
EXCERPT_LENGTH = 180
CURSOR_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MAX_NEWS_ID = 9_223_372_036_854_775_807


def serialize_staff_news(item: News) -> StaffNews:
    return StaffNews(
        id=str(item.id),
        title=item.title,
        body=item.body,
        author_user_id=str(item.author_user_id) if item.author_user_id is not None else None,
        published_at=item.published_at,
        is_published=item.is_published,
    )


def list_staff_news(db: Session, *, limit: int, cursor: str | None) -> StaffNewsPage:
    after = decode_page_cursor(cursor, key_types=(int,), direction="desc")
    statement = select(News)
    if after is not None:
        if not 1 <= after[0] <= MAX_NEWS_ID:
            raise InvalidCursorError("Invalid news cursor")
        statement = statement.where(News.id < after[0])
    rows = db.scalars(statement.order_by(News.id.desc()).limit(limit + 1)).all()
    page = paginate_results(
        rows,
        key=lambda item: (item.id,),
        key_types=(int,),
        direction="desc",
        limit=limit,
    )
    return StaffNewsPage(
        items=[serialize_staff_news(item) for item in page.items], next_cursor=page.next_cursor
    )


def get_staff_news(db: Session, news_id: int, *, for_update: bool = False) -> News | None:
    statement = select(News).where(News.id == news_id)
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def create_staff_news(db: Session, actor: User, content: NewsContent) -> News:
    item = News(title=content.title, body=content.body, author_user_id=actor.id, is_published=False)
    try:
        db.add(item)
        db.flush()
        write_audit_event(
            db,
            actor=actor,
            entity_type="news",
            entity_id=item.id,
            action="create",
            before_data=None,
            after_data={
                "title": item.title,
                "body": item.body,
                "is_published": False,
                "published_at": None,
                "author_user_id": actor.id,
            },
        )
        db.commit()
        return item
    except Exception:
        db.rollback()
        raise


def update_staff_news(db: Session, actor: User, item: News, content: NewsContent) -> News:
    changes = {
        key: getattr(content, key)
        for key in ("title", "body")
        if getattr(item, key) != getattr(content, key)
    }
    if not changes:
        return item
    before = {key: getattr(item, key) for key in changes}
    try:
        changed = db.scalar(
            update(News)
            .where(News.id == item.id)
            .values(**changes)
            .returning(News)
            .execution_options(synchronize_session=False, populate_existing=True)
        )
        if changed is None:
            raise ValueError("News disappeared during update")
        write_audit_event(
            db,
            actor=actor,
            entity_type="news",
            entity_id=item.id,
            action="update",
            before_data=before,
            after_data={key: getattr(changed, key) for key in changes},
        )
        db.commit()
        return changed
    except Exception:
        db.rollback()
        raise


def set_news_publication(db: Session, actor: User, item: News, *, publish: bool) -> News:
    if item.is_published == publish:
        return item
    previous = {"is_published": item.is_published, "published_at": item.published_at}
    now = db.scalar(select(func.now()))
    values = {"is_published": publish}
    action = "publish" if publish else "unpublish"
    if publish:
        values["published_at"] = now
    try:
        changed = db.scalar(
            update(News)
            .where(News.id == item.id)
            .values(**values)
            .returning(News)
            .execution_options(synchronize_session=False, populate_existing=True)
        )
        if changed is None:
            raise ValueError("News disappeared during publication")
        write_audit_event(
            db,
            actor=actor,
            entity_type="news",
            entity_id=item.id,
            action=action,
            before_data=previous,
            after_data={"is_published": changed.is_published, "published_at": changed.published_at},
        )
        db.commit()
        return changed
    except Exception:
        db.rollback()
        raise


def create_excerpt(body: str) -> str:
    """Collapse all whitespace; cap at 180 Unicode code points, ellipsis included."""
    normalized = re.sub(r"\s+", " ", body, flags=re.UNICODE).strip()
    if len(normalized) <= EXCERPT_LENGTH:
        return normalized
    return normalized[: EXCERPT_LENGTH - 1].rstrip() + "…"


def _cursor_key(news: News) -> CursorKey:
    assert news.published_at is not None
    published_at = news.published_at.astimezone(UTC)
    elapsed = published_at - CURSOR_EPOCH
    timestamp_microseconds = (
        elapsed.days * 86_400_000_000 + elapsed.seconds * 1_000_000 + elapsed.microseconds
    )
    return timestamp_microseconds, news.id


def list_published_news(db: Session, *, limit: int, cursor: str | None) -> NewsPage:
    after = decode_page_cursor(cursor, key_types=NEWS_CURSOR_TYPES, direction="desc")
    statement = select(News).where(
        News.is_published.is_(True),
        News.published_at.is_not(None),
        News.published_at <= func.now(),
    )
    if after is not None:
        try:
            max_microseconds = datetime.max.replace(tzinfo=UTC) - CURSOR_EPOCH
            min_microseconds = datetime.min.replace(tzinfo=UTC) - CURSOR_EPOCH
            if (
                not min_microseconds.days * 86_400_000_000
                <= after[0]
                <= max_microseconds.days * 86_400_000_000
                + max_microseconds.seconds * 1_000_000
                + max_microseconds.microseconds
                or not 1 <= after[1] <= MAX_NEWS_ID
            ):
                raise ValueError
            published_at = CURSOR_EPOCH + timedelta(microseconds=after[0])
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
