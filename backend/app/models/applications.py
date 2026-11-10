from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ServiceType(Base):
    __tablename__ = "service_types"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_service_types"),
        UniqueConstraint("code", name="uq_service_types_code"),
        Index("ix_service_types_responsible_org_unit_id", "responsible_org_unit_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    code: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    processing_mode: Mapped[str] = mapped_column(String, nullable=False)
    responsible_org_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_service_types_responsible_org_unit_id_org_units"),
        nullable=True,
    )
    produces_document: Mapped[bool] = mapped_column(Boolean, nullable=False)


class Application(Base):
    __tablename__ = "applications"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_applications"),
        CheckConstraint(
            "review_status IN ('submitted','in_review','needs_correction','resubmitted',"
            "'approved','rejected')",
            name="ck_applications_review_status",
        ),
        CheckConstraint(
            "document_status IN ('not_required','pending','ready','failed')",
            name="ck_applications_document_status",
        ),
        CheckConstraint("version > 0", name="ck_applications_version"),
        Index("ix_applications_student_id_created_at", "student_id", "created_at"),
        Index("ix_applications_service_type_id", "service_type_id"),
        Index(
            "ix_applications_assigned_org_unit_id_review_status",
            "assigned_org_unit_id",
            "review_status",
        ),
        Index("ix_applications_reviewer_user_id", "reviewer_user_id"),
    )
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    student_id: Mapped[int] = mapped_column(
        ForeignKey("students.id", name="fk_applications_student_id_students"), nullable=False
    )
    service_type_id: Mapped[int] = mapped_column(
        ForeignKey("service_types.id", name="fk_applications_service_type_id_service_types"),
        nullable=False,
    )
    review_status: Mapped[str] = mapped_column(String, nullable=False)
    document_status: Mapped[str] = mapped_column(String, nullable=False)
    form_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    assigned_org_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("org_units.id", name="fk_applications_assigned_org_unit_id_org_units"),
        nullable=True,
    )
    reviewer_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="fk_applications_reviewer_user_id_users"), nullable=True
    )
    feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
