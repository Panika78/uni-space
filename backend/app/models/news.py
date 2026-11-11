from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    PrimaryKeyConstraint,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class News(Base):
    __tablename__ = "news"
    __table_args__ = (
        CheckConstraint("title !~ '^[[:space:]]*$'", name="ck_news_title_not_blank"),
        PrimaryKeyConstraint("id", name="pk_news"),
        Index("ix_news_published_at_id", "published_at", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="fk_news_author_user_id_users"), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_published: Mapped[bool] = mapped_column(
        nullable=False, default=False, server_default="false"
    )
