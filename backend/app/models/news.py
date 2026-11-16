from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class News(Base):
    __tablename__ = "news"
    __table_args__ = (
        CheckConstraint("title !~ '^[[:space:]]*$'", name="ck_news_title_not_blank"),
        CheckConstraint("version > 0", name="ck_news_version"),
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
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")


class NewsCreateRequest(Base):
    __tablename__ = "news_create_requests"
    __table_args__ = (
        CheckConstraint(
            "(news_id IS NULL AND response_data IS NULL) OR "
            "(news_id IS NOT NULL AND response_data IS NOT NULL)",
            name="ck_news_create_requests_result",
        ),
        PrimaryKeyConstraint(
            "actor_user_id", "org_unit_id", "idempotency_key", name="pk_news_create_requests"
        ),
    )

    actor_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    org_unit_id: Mapped[int] = mapped_column(
        ForeignKey("org_units.id", ondelete="CASCADE"), primary_key=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    news_id: Mapped[int | None] = mapped_column(
        ForeignKey("news.id", ondelete="CASCADE"), nullable=True
    )
    response_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
