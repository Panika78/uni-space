from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from pydantic import Field, StrictStr
from sqlalchemy.orm import Session

from app.auth.rate_limit import LoginRateLimiter
from app.auth.security import create_access_token
from app.auth.service import create_login_session, revoke_logout_session, rotate_refresh_token
from app.core.config import Settings, get_settings
from app.core.schemas import ApiError, RequestModel
from app.dependencies.database import get_db_session

COOKIE_NAME = "uni_space_refresh"
COOKIE_PATH = "/api/v1/auth"
login_rate_limiter = LoginRateLimiter()


class LoginRequest(RequestModel):
    login: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    password: Annotated[StrictStr, Field(min_length=1, max_length=1024)]


class TokenResponse(RequestModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int


def require_auth_origin(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    origin: Annotated[str | None, Header(description="Обязательный разрешённый origin")] = None,
) -> None:
    origins = request.headers.getlist("origin")
    if len(origins) != 1 or origins[0] not in settings.allowed_origins:
        raise HTTPException(403, "origin_not_allowed")


def require_login_attempt(request: Request) -> None:
    login_rate_limiter.require_attempt(request.client.host if request.client else "unknown")


async def require_empty_body(request: Request) -> None:
    if await request.body():
        raise HTTPException(422, "validation_error")


router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
    dependencies=[Depends(require_auth_origin)],
    responses={
        401: {"model": ApiError},
        403: {"model": ApiError},
        422: {"model": ApiError},
        500: {"model": ApiError},
    },
)
Database = Annotated[Session, Depends(get_db_session)]
AuthSettings = Annotated[Settings, Depends(get_settings)]


def set_refresh_cookie(
    response: Response, token: str, expires: datetime, settings: Settings
) -> None:
    remaining = max(0, int((expires - datetime.now(UTC)).total_seconds()))
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=remaining,
        expires=expires.astimezone(UTC),
        path=COOKIE_PATH,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


@router.post(
    "/login",
    response_model=TokenResponse,
    dependencies=[Depends(require_login_attempt)],
    responses={
        429: {
            "model": ApiError,
            "headers": {"Retry-After": {"schema": {"type": "integer", "minimum": 1}}},
        }
    },
)
def login_user(
    body: LoginRequest, response: Response, db: Database, settings: AuthSettings
) -> dict:
    session, token = create_login_session(db, body.login, body.password, settings)
    access = create_access_token(session, settings)
    set_refresh_cookie(response, token, session.expires_at, settings)
    return access


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(require_empty_body)])
def refresh_session(
    response: Response,
    db: Database,
    settings: AuthSettings,
    refresh_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> dict:
    session, token = rotate_refresh_token(db, refresh_cookie)
    access = create_access_token(session, settings)
    set_refresh_cookie(response, token, session.expires_at, settings)
    return access


@router.post("/logout", status_code=204, dependencies=[Depends(require_empty_body)])
def logout_session(
    db: Database,
    settings: AuthSettings,
    refresh_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    revoke_logout_session(db, refresh_cookie)
    response = Response(status_code=204)
    response.delete_cookie(
        COOKIE_NAME, path=COOKIE_PATH, secure=settings.cookie_secure, httponly=True, samesite="lax"
    )
    return response
