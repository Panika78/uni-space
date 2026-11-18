"""Shared operational audit; domain authorization belongs to the caller."""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_entity_created_id", "entity_type", "entity_id", "created_at", "id"),
        Index(
            "ix_audit_events_journal_pair",
            "entity_type",
            # Match PostgreSQL's deparsed CASE expressions for Alembic comparison.
            text("""(
CASE
    WHEN action::text = 'delete'::text THEN before_data
    ELSE after_data
END ->
CASE
    WHEN entity_type::text = 'assessment_result'::text THEN 'assessment_group_id'::text
    ELSE 'course_offering_id'::text
END)"""),
            text("""(
CASE
    WHEN action::text = 'delete'::text THEN before_data
    ELSE after_data
END -> 'student_id'::text)"""),
            text("created_at DESC"),
            text("id DESC"),
            postgresql_where=text(
                "entity_type IN ('assessment_result', 'final_result') "
                "AND action IN ('create', 'update', 'delete')"
            ),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="fk_audit_events_actor_user_id_users"), nullable=True
    )
    entity_type: Mapped[str] = mapped_column(String, nullable=False)
    entity_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    before_data: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    after_data: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.statement_timestamp()
    )
