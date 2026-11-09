import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.auth.security import DUMMY_PASSWORD_HASH, validate_access_token, verify_password
from app.core.config import Settings
from app.models import AuthSession, RefreshToken, User


def hash_refresh_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def create_refresh_token(
    db: Session, session: AuthSession, now: datetime, parent: RefreshToken | None = None
) -> str:
    token = secrets.token_urlsafe(32)
    db.add(
        RefreshToken(
            session_id=session.id,
            token_hash=hash_refresh_token(token),
            parent_token_id=parent.id if parent else None,
            created_at=now,
            expires_at=session.expires_at,
        )
    )
    return token


def create_login_session(
    db: Session, login: str, password: str, settings: Settings
) -> tuple[AuthSession, str]:
    with db.begin():
        # Read scalar values: an ORM refresh under the later lock must not mutate
        # the hash snapshot against which the expensive verification succeeded.
        snapshot = db.execute(
            select(User.id, User.password_hash, User.is_active).where(User.login == login)
        ).one_or_none()
        valid = verify_password(
            snapshot.password_hash if snapshot else DUMMY_PASSWORD_HASH, password
        )
        if not valid or snapshot is None or not snapshot.is_active:
            raise HTTPException(401, "invalid_credentials")
        user = db.scalar(
            select(User)
            .where(User.id == snapshot.id, User.login == login)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        # Changed hashes are rejected rather than re-running Argon2id under a lock.
        # The user lock remains held through session + first refresh commit.
        if user is None or not user.is_active or user.password_hash != snapshot.password_hash:
            raise HTTPException(401, "invalid_credentials")
        now = datetime.now(UTC)
        session = AuthSession(
            user_id=user.id,
            created_at=now,
            expires_at=now + timedelta(seconds=settings.session_ttl_seconds),
        )
        db.add(session)
        db.flush()
        token = create_refresh_token(db, session, now)
    return session, token


def get_locked_refresh_session(
    db: Session, raw_token: str | None
) -> tuple[AuthSession, RefreshToken] | None:
    if not raw_token or len(raw_token) > 512:
        return None
    token_hash = hash_refresh_token(raw_token)
    session_id = db.scalar(
        select(RefreshToken.session_id).where(RefreshToken.token_hash == token_hash)
    )
    if session_id is None:
        return None
    # All refresh/logout writers lock the session first. READ COMMITTED plus
    # populate_existing prevents identity-map snapshots surviving a lock wait.
    session = db.scalar(
        select(AuthSession)
        .where(AuthSession.id == session_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    token = db.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == token_hash)
        .execution_options(populate_existing=True)
    )
    if session is None or token is None or token.session_id != session.id:
        return None
    return session, token


def revoke_session(db: Session, session: AuthSession, now: datetime, reason: str) -> None:
    if session.revoked_at is None:
        session.revoked_at = now
        session.revocation_reason = reason
    db.execute(
        update(RefreshToken)
        .where(RefreshToken.session_id == session.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


def rotate_refresh_token(db: Session, raw_token: str | None) -> tuple[AuthSession, str]:
    result = None
    with db.begin():
        locked = get_locked_refresh_session(db, raw_token)
        if locked:
            session, token = locked
            now = datetime.now(UTC)  # Read time after waiting for the lock.
            user = db.scalar(
                select(User)
                .where(User.id == session.user_id)
                .execution_options(populate_existing=True)
            )
            parent_session_id = (
                db.scalar(
                    select(RefreshToken.session_id).where(RefreshToken.id == token.parent_token_id)
                )
                if token.parent_token_id is not None
                else session.id
            )
            if token.used_at is not None:
                revoke_session(db, session, now, "reuse_detected")
            elif (
                user is not None
                and user.is_active
                and session.revoked_at is None
                and token.revoked_at is None
                and session.expires_at > now
                and token.expires_at > now
                and token.expires_at <= session.expires_at
                and parent_session_id == session.id
            ):
                token.used_at = now
                session.last_used_at = now
                db.flush()  # Release the one-active-token unique index before insertion.
                result = session, create_refresh_token(db, session, now, token)
    # A rejected reuse is a committed revocation, never an exception inside begin().
    if result is None:
        raise HTTPException(401, "invalid_refresh")
    return result


def revoke_logout_session(
    db: Session, raw_token: str | None, settings: Settings, access_token: str | None = None
) -> None:
    with db.begin():
        locked = get_locked_refresh_session(db, raw_token)
        if locked:
            session, _token = locked
            revoke_session(db, session, datetime.now(UTC), "logout")
            return  # A known cookie always wins, including used/revoked refresh tokens.
        if not access_token:
            return
        try:
            claims = validate_access_token(access_token, settings)
        except HTTPException as error:
            if error.status_code != 401:
                raise
            return  # Optional, unusable credentials retain idempotent logout semantics.
        session = db.scalar(
            select(AuthSession)
            .where(AuthSession.id == int(claims["sid"]), AuthSession.user_id == int(claims["sub"]))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if session is not None:
            revoke_session(db, session, datetime.now(UTC), "logout")
