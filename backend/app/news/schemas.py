from typing import Annotated

from pydantic import PositiveInt, StringConstraints, field_validator

from app.core.schemas import DateTime, Id, Page, RequestModel


class NewsPreview(RequestModel):
    id: Id
    title: str
    excerpt: str
    published_at: DateTime


class News(NewsPreview):
    body: str


NewsPage = Page[NewsPreview]


class StaffNews(RequestModel):
    id: Id
    title: str
    body: str
    author_user_id: Id | None
    published_at: DateTime | None
    is_published: bool
    version: PositiveInt


def validate_news_text(value: str) -> str:
    if "\x00" in value or any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("Invalid text")
    return value


class NewsContent(RequestModel):
    title: Annotated[str, StringConstraints(min_length=1, max_length=200, strip_whitespace=True)]
    body: Annotated[str, StringConstraints(min_length=1, max_length=20_000)]

    @field_validator("title", "body")
    @classmethod
    def validate_text(cls, value: str) -> str:
        value = validate_news_text(value)
        if not value.strip():
            raise ValueError("Text must not be blank")
        return value


class NewsUpdate(NewsContent):
    version: PositiveInt


class StaffNewsPage(Page[StaffNews]):
    pass
