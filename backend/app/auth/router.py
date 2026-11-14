from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import Field, StrictStr
from sqlalchemy.orm import Session

from app.auth.body_limit import AuthRoute
from app.auth.rate_limit import LoginRateLimiter
from app.auth.security import create_access_token
from app.auth.service import create_login_session, revoke_logout_session, rotate_refresh_token
from app.core.config import Settings, get_settings
from app.core.schemas import ApiError, RequestModel
from app.dependencies.auth import bearer
from app.dependencies.database import get_db_session

COOKIE_NAME = "__Host-uni_space_refresh"
COOKIE_PATH = "/api/v1/auth"
COOKIE_SCOPE = "/"
LEGACY_COOKIE_NAME = "uni_space_refresh"
LEGACY_COOKIE_PATH = "/api/v1/auth"
INSECURE_COOKIE_NAME = "uni_space_refresh_dev"
login_rate_limiter = LoginRateLimiter()


class LoginRequest(RequestModel):
    login: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    password: Annotated[StrictStr, Field(min_length=1, max_length=1024)]


class TokenResponse(RequestModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int


class LogoutResponse(RequestModel):
    session_revoked: bool


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
    # AuthRoute has already bounded and buffered the body before FastAPI parsing.
    if await request.body():
        raise HTTPException(422, "validation_error")


router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
    route_class=AuthRoute,
    dependencies=[Depends(require_auth_origin)],
    responses={
        401: {"model": ApiError},
        403: {"model": ApiError},
        413: {"model": ApiError, "description": "Тело auth-запроса превышает 16384 байта"},
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
    cookie_name = COOKIE_NAME if settings.cookie_secure else INSECURE_COOKIE_NAME
    response.set_cookie(
        cookie_name,
        token,
        max_age=remaining,
        expires=expires.astimezone(UTC),
        path=COOKIE_SCOPE if settings.cookie_secure else COOKIE_PATH,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def get_unique_cookie(request: Request, name: str) -> str | None:
    """Return a cookie only when exactly one matching pair was sent."""
    values = []
    for header in request.headers.getlist("cookie"):
        for pair in header.split(";"):
            key, separator, value = pair.strip().partition("=")
            if separator and key.strip() == name:
                values.append(value.strip())
    return values[0] if len(values) == 1 else None


def clear_legacy_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        LEGACY_COOKIE_NAME,
        path=LEGACY_COOKIE_PATH,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def get_active_cookie(request: Request, settings: Settings) -> str | None:
    return get_unique_cookie(
        request, COOKIE_NAME if settings.cookie_secure else INSECURE_COOKIE_NAME
    )


def clear_insecure_cookie(response: Response, settings: Settings) -> None:
    if not settings.cookie_secure:
        response.delete_cookie(
            INSECURE_COOKIE_NAME,
            path=COOKIE_PATH,
            secure=False,
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
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Database,
    settings: AuthSettings,
) -> dict:
    session, token = create_login_session(
        db,
        body.login,
        body.password,
        settings,
        previous_refresh_token=get_active_cookie(request, settings),
    )
    access = create_access_token(session, settings)
    set_refresh_cookie(response, token, session.expires_at, settings)
    clear_legacy_cookie(response, settings)
    return access


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(require_empty_body)])
def refresh_session(
    request: Request,
    response: Response,
    db: Database,
    settings: AuthSettings,
    refresh_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> dict:
    refresh_cookie = get_active_cookie(request, settings)
    if refresh_cookie is None:
        raise HTTPException(401, "invalid_refresh")
    session, token = rotate_refresh_token(db, refresh_cookie)
    access = create_access_token(session, settings)
    set_refresh_cookie(response, token, session.expires_at, settings)
    return access


@router.post(
    "/logout",
    response_model=LogoutResponse,
    dependencies=[Depends(require_empty_body)],
    openapi_extra={"security": [{}]},
    description=(
        "Refresh-cookie имеет приоритет. При неизвестной/отсутствующей cookie используется "
        "необязательный валидный Bearer с проверкой владельца sid. Поле session_revoked "
        "сообщает, была ли найдена и отозвана конкретная сессия; cookie удаляется при любом ответе."
    ),
)
def logout_session(
    request: Request,
    db: Database,
    settings: AuthSettings,
    response: Response,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    refresh_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> dict:
    session_revoked = revoke_logout_session(
        db,
        get_active_cookie(request, settings),
        settings,
        credentials.credentials if credentials else None,
    )
    response.delete_cookie(
        COOKIE_NAME, path=COOKIE_SCOPE, secure=settings.cookie_secure, httponly=True, samesite="lax"
    )
    clear_legacy_cookie(response, settings)
    clear_insecure_cookie(response, settings)
    return {"session_revoked": session_revoked}
