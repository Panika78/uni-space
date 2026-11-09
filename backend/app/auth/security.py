import re
from datetime import UTC, datetime
from uuid import uuid4

import jwt
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException

from app.core.config import Settings
from app.models import AuthSession

PASSWORD_HASHER = PasswordHasher(type=Type.ID)
# Unknown logins still perform an Argon2id verification.
DUMMY_PASSWORD_HASH = PASSWORD_HASHER.hash("unused-dummy-password")
REQUIRED_CLAIMS = ("exp", "iat", "iss", "aud", "sub", "sid", "jti", "token_type")


def verify_password(password_hash: str, password: str) -> bool:
    if not password_hash.startswith("$argon2id$"):
        PASSWORD_HASHER.verify(DUMMY_PASSWORD_HASH, "unused-dummy-password")
        return False
    try:
        return PASSWORD_HASHER.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(session: AuthSession, settings: Settings) -> dict:
    now = int(datetime.now(UTC).timestamp())
    expires = min(now + settings.access_ttl_seconds, int(session.expires_at.timestamp()))
    if expires <= now:
        raise HTTPException(401, "session_invalid")
    token = jwt.encode(
        {
            "sub": str(session.user_id),
            "sid": str(session.id),
            "jti": str(uuid4()),
            "iss": settings.jwt_issuer,
            "aud": settings.jwt_audience,
            "iat": now,
            "exp": expires,
            "token_type": "access",
        },
        settings.jwt_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    return {"access_token": token, "token_type": "bearer", "expires_in": expires - now}


def validate_access_token(token: str, settings: Settings) -> dict:
    try:
        # Validate types before PyJWT's NumericDate coercion and expiry classification.
        claims = jwt.decode(
            token,
            settings.jwt_signing_key.get_secret_value(),
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
            options={
                "require": REQUIRED_CLAIMS,
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
        )
        for name in ("exp", "iat", "nbf"):
            if name in claims and (type(claims[name]) is not int or claims[name] < 0):
                raise jwt.InvalidTokenError()
        for name in ("sub", "sid"):
            value = claims[name]
            if (
                not isinstance(value, str)
                or not re.fullmatch(r"[1-9][0-9]{0,18}", value)
                or int(value) > 9223372036854775807
            ):
                raise jwt.InvalidTokenError()
        if (
            claims["token_type"] != "access"
            or type(claims["jti"]) is not str
            or not claims["jti"].strip()
            or type(claims["iss"]) is not str
            or type(claims["aud"]) is not str
            or claims["exp"] <= claims["iat"]
        ):
            raise jwt.InvalidTokenError()
        now = datetime.now(UTC).timestamp()
        if claims["iat"] > now or claims.get("nbf", 0) > now:
            raise jwt.InvalidTokenError()
        return jwt.decode(
            token,
            settings.jwt_signing_key.get_secret_value(),
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
            options={"require": REQUIRED_CLAIMS},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "access_expired") from None
    except jwt.InvalidTokenError:
        raise HTTPException(401, "invalid_access") from None
