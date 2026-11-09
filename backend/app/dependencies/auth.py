from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.security import validate_access_token
from app.core.config import Settings, get_settings
from app.dependencies.database import get_db_session
from app.models import AuthSession, Student, User

bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[Session, Depends(get_db_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "invalid_access")
    claims = validate_access_token(credentials.credentials, settings)
    result = db.execute(
        select(User, AuthSession)
        .join(AuthSession, AuthSession.user_id == User.id)
        .where(User.id == int(claims["sub"]), AuthSession.id == int(claims["sid"]))
        .execution_options(populate_existing=True)
    ).one_or_none()
    if result is None:
        raise HTTPException(401, "session_invalid")
    user, session = result
    if not user.is_active or session.revoked_at or session.expires_at <= datetime.now(UTC):
        raise HTTPException(401, "session_invalid")
    return user


def get_current_student(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> Student:
    if user.role != "student":
        raise HTTPException(403, "forbidden")
    student = db.scalar(select(Student).where(Student.user_id == user.id))
    if student is None:
        raise HTTPException(403, "forbidden")
    return student
