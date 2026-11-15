from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import StrictBool
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, RequestModel
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import User
from app.models.preferences import UserPreferences
from app.preferences_service import save_user_preferences


class PreferencesResponse(RequestModel):
    show_cancelled_lessons: StrictBool = True


class PreferencesUpdate(RequestModel):
    show_cancelled_lessons: StrictBool


router = APIRouter(prefix="/api/v1/users/me/preferences", tags=["preferences"])


@router.get("", response_model=PreferencesResponse, responses={401: {"model": ApiError}})
def get_user_preferences(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> PreferencesResponse:
    row = db.get(UserPreferences, user.id)
    return PreferencesResponse(**row.preferences) if row else PreferencesResponse()


@router.patch(
    "",
    response_model=PreferencesResponse,
    responses={code: {"model": ApiError} for code in (401, 422)},
)
def update_user_preferences(
    data: PreferencesUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> PreferencesResponse:
    return PreferencesResponse(**save_user_preferences(db, user.id, data.model_dump()))
