from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, PrimaryKeyConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserPreferences(Base):
    __tablename__ = "user_preferences"
    __table_args__ = (
        PrimaryKeyConstraint("user_id", name="pk_user_preferences"),
        CheckConstraint(
            "jsonb_typeof(preferences) = 'object' AND "
            "preferences ? 'show_cancelled_lessons' AND "
            "preferences - 'show_cancelled_lessons' = '{}'::jsonb AND "
            "jsonb_typeof(preferences -> 'show_cancelled_lessons') = 'boolean'",
            name="ck_user_preferences_values",
        ),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", name="fk_user_preferences_user_id_users", ondelete="CASCADE"),
        primary_key=True,
    )
    preferences: Mapped[dict[str, bool]] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
