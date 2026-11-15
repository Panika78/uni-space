from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models.preferences import UserPreferences


def save_user_preferences(db: Session, user_id: int, values: dict[str, bool]) -> dict[str, bool]:
    """Atomically create or replace this account's single implemented preference."""
    try:
        db.execute(
            insert(UserPreferences)
            .values(user_id=user_id, preferences=values)
            .on_conflict_do_update(
                index_elements=[UserPreferences.user_id],
                set_={"preferences": values, "updated_at": func.now()},
            )
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return values
