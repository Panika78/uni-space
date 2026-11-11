from app.core.schemas import DateTime, Id, Page, RequestModel


class NewsPreview(RequestModel):
    id: Id
    title: str
    excerpt: str
    published_at: DateTime


class News(NewsPreview):
    body: str


NewsPage = Page[NewsPreview]
