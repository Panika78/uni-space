from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    LargeBinary,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("login", name="uq_users_login"),
        PrimaryKeyConstraint("id", name="pk_users"),
        CheckConstraint(
            "role IN ('student', 'teacher', 'staff', 'admin')",
            name="ck_users_role",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    login: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str] = mapped_column(String, nullable=False)
    avatar_storage_key: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[bool] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="ck_auth_sessions_expiry"),
        CheckConstraint(
            "last_used_at IS NULL OR last_used_at >= created_at",
            name="ck_auth_sessions_last_used_at",
        ),
        CheckConstraint(
            "revoked_at IS NULL OR revoked_at >= created_at",
            name="ck_auth_sessions_revoked_at",
        ),
        PrimaryKeyConstraint("id", name="pk_auth_sessions"),
        Index(
            "ix_auth_sessions_user_revoked_expires",
            "user_id",
            "revoked_at",
            "expires_at",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", name="fk_auth_sessions_user_id_users"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revocation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_refresh_tokens_token_hash"),
        UniqueConstraint("parent_token_id", name="uq_refresh_tokens_parent_token_id"),
        PrimaryKeyConstraint("id", name="pk_refresh_tokens"),
        CheckConstraint("expires_at > created_at", name="ck_refresh_tokens_expiry"),
        CheckConstraint(
            "octet_length(token_hash) = 32",
            name="ck_refresh_tokens_token_hash_sha256_length",
        ),
        CheckConstraint(
            "parent_token_id IS NULL OR parent_token_id <> id",
            name="ck_refresh_tokens_parent_not_self",
        ),
        CheckConstraint(
            "used_at IS NULL OR used_at >= created_at",
            name="ck_refresh_tokens_used_at",
        ),
        CheckConstraint(
            "revoked_at IS NULL OR revoked_at >= created_at",
            name="ck_refresh_tokens_revoked_at",
        ),
        Index("ix_refresh_tokens_session_created", "session_id", "created_at"),
        Index(
            "uq_refresh_tokens_one_active_per_session",
            "session_id",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("auth_sessions.id", name="fk_refresh_tokens_session_id_auth_sessions"),
        nullable=False,
    )
    token_hash: Mapped[bytes] = mapped_column(LargeBinary(32), nullable=False)
    parent_token_id: Mapped[int | None] = mapped_column(
        ForeignKey("refresh_tokens.id", name="fk_refresh_tokens_parent_token_id_refresh_tokens"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_notifications"),
        Index("ix_notifications_user_created_id", "user_id", "created_at", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", name="fk_notifications_user_id_users"), nullable=False
    )
    type: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String, nullable=True)
    entity_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
