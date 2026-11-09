from datetime import UTC, datetime, timedelta

import jwt
import pytest
from argon2 import PasswordHasher, Type
from fastapi import HTTPException
from pydantic import ValidationError

from app.auth.rate_limit import LoginRateLimiter
from app.auth.security import create_access_token, validate_access_token, verify_password
from app.core.config import Settings
from app.models import AuthSession

KEY = "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def auth_settings(**values):
    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://test:test@localhost/test",
        jwt_signing_key=KEY,
        **values,
    )


def claims():
    now = int(datetime.now(UTC).timestamp())
    return dict(
        exp=now + 600,
        iat=now,
        iss="uni-space",
        aud="uni-space-api",
        sub="1",
        sid="2",
        jti="unique-id",
        token_type="access",
    )


@pytest.mark.parametrize("field", ["exp", "iat", "iss", "aud", "sub", "sid", "jti", "token_type"])
def test_access_requires_every_claim(field):
    payload = claims()
    del payload[field]
    token = jwt.encode(payload, KEY, algorithm="HS256")
    with pytest.raises(HTTPException) as error:
        validate_access_token(token, auth_settings())
    assert error.value.detail == "invalid_access"


@pytest.mark.parametrize(
    "field,value",
    [
        ("exp", "9999999999"),
        ("exp", True),
        ("exp", 9999999999.0),
        ("exp", None),
        ("exp", -1),
        ("iat", "1"),
        ("iat", True),
        ("iat", 9999999999),
        ("nbf", "1"),
        ("nbf", True),
        ("nbf", 9999999999),
        ("iss", "other"),
        ("iss", ["uni-space"]),
        ("aud", "other"),
        ("aud", ["uni-space-api"]),
        ("sub", 1),
        ("sub", "0"),
        ("sub", "-1"),
        ("sub", "01"),
        ("sid", "1.0"),
        ("sid", None),
        ("sid", "9223372036854775808"),
        ("sid", "9" * 5000),
        ("jti", ""),
        ("jti", " "),
        ("jti", 3),
        ("token_type", "refresh"),
        ("token_type", None),
    ],
)
def test_access_rejects_invalid_claim_types_and_values(field, value):
    payload = claims() | {field: value}
    token = jwt.encode(payload, KEY, algorithm="HS256")
    with pytest.raises(HTTPException) as error:
        validate_access_token(token, auth_settings())
    assert error.value.detail == "invalid_access"


@pytest.mark.parametrize("algorithm,key", [("HS512", KEY), ("HS256", KEY + "wrong"), ("none", "")])
def test_access_rejects_algorithm_and_signature(algorithm, key):
    with pytest.raises(HTTPException) as error:
        validate_access_token(jwt.encode(claims(), key, algorithm=algorithm), auth_settings())
    assert error.value.detail == "invalid_access"


def test_access_distinguishes_expiry_and_accepts_valid_nbf():
    payload = claims()
    payload.update(iat=payload["iat"] - 100, exp=payload["iat"] - 1)
    with pytest.raises(HTTPException) as error:
        validate_access_token(jwt.encode(payload, KEY, algorithm="HS256"), auth_settings())
    assert error.value.detail == "access_expired"
    payload = claims() | {"nbf": int(datetime.now(UTC).timestamp()) - 1}
    assert validate_access_token(jwt.encode(payload, KEY, algorithm="HS256"), auth_settings())


def test_access_lifetime_is_capped_by_session():
    session = AuthSession(id=2, user_id=1, expires_at=datetime.now(UTC) + timedelta(seconds=12))
    result = create_access_token(session, auth_settings())
    assert 0 < result["expires_in"] <= 12
    assert validate_access_token(result["access_token"], auth_settings())["exp"] <= int(
        session.expires_at.timestamp()
    )


def test_password_requires_argon2id():
    password = "fictional-password"
    assert verify_password(PasswordHasher(type=Type.ID).hash(password), password)
    assert not verify_password(PasswordHasher(type=Type.I).hash(password), password)
    assert not verify_password("$argon2id$broken", password)
    assert not verify_password(PasswordHasher().hash(password), "incorrect")


@pytest.mark.parametrize(
    "values",
    [
        {"cookie_secure": False},
        {"allowed_origins": ["http://localhost:5173"]},
        {"jwt_signing_key": "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
        {"jwt_signing_key": "x" * 64},
        {"jwt_signing_key": ""},
    ],
)
def test_production_rejects_insecure_auth_configuration(values):
    defaults = dict(
        app_env="production",
        cookie_secure=True,
        allowed_origins=["https://uni.example"],
        jwt_signing_key="2ghJj3eYC65ZV4zuLr8s-91QTNpXvWbA",
    )
    defaults.update(values)
    key = defaults.pop("jwt_signing_key")
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            database_url="postgresql+psycopg://test:test@localhost/test",
            jwt_signing_key=key,
            **defaults,
        )


def test_production_accepts_private_key_and_https():
    settings = Settings(
        _env_file=None,
        app_env="production",
        database_url="postgresql+psycopg://test:test@localhost/test",
        jwt_signing_key="2ghJj3eYC65ZV4zuLr8s-91QTNpXvWbA",
        allowed_origins=["https://uni.example"],
    )
    assert settings.cookie_secure


@pytest.mark.parametrize(
    "origins",
    [
        [],
        ["null"],
        ["*"],
        ["https://uni.example/"],
        ["https://a:b@uni.example"],
        ["https://a:99999"],
        ["https://uni.example?"],
        ["https://uni.example#"],
        ["https://uni.example:"],
        ["https://uni.example:0"],
        ["https://uni.example:65536"],
        ["https://uni.example:-1"],
        ["https://uni.example:+443"],
        ["https://uni.example:abc"],
        ["https://uni.example:443:"],
        ["https://uni.example:443?"],
        ["https://uni.example:443#"],
        ["https://uni.example/evil"],
        ["https://uni.example\n"],
        ["https://uni. example"],
        ["https://uni.example\t"],
        ["https://uni.example\\evil"],
        ["https://user@uni.example"],
        ["https://[::1]:"],
        ["https://[::1]?"],
        ["https://[::1]#"],
        ["https://[:::1]"],
        ["https://::1"],
        ["https://[fe80::1%25eth0]"],
        ["https://-uni.example"],
        ["https://uni..example"],
        ["https://256.256.256.256"],
    ],
)
def test_origin_configuration_requires_exact_origins(origins):
    with pytest.raises(ValidationError):
        auth_settings(allowed_origins=origins)


@pytest.mark.parametrize(
    "field,value",
    [
        ("access_ttl_seconds", 0),
        ("session_ttl_seconds", -1),
        ("jwt_issuer", " "),
        ("jwt_audience", ""),
    ],
)
def test_auth_configuration_rejects_invalid_ttls_and_identifiers(field, value):
    with pytest.raises(ValidationError):
        auth_settings(**{field: value})


def test_limiter_retry_after_expiry_and_cleanup(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("app.auth.rate_limit.time.monotonic", lambda: clock[0])
    limiter = LoginRateLimiter(limit=1, window_seconds=60)
    limiter.require_attempt("peer")
    clock[0] = 100.2
    with pytest.raises(HTTPException) as error:
        limiter.require_attempt("peer")
    assert error.value.headers == {"Retry-After": "60"}
    clock[0] = 159.9
    with pytest.raises(HTTPException) as error:
        limiter.require_attempt("peer")
    assert error.value.headers == {"Retry-After": "1"}
    clock[0] = 160
    limiter.require_attempt("other")
    assert "peer" not in limiter._windows
    limiter.require_attempt("peer")


def test_missing_signing_key_has_no_fallback_and_diagnostic_hides_values(monkeypatch):
    from app.core.config import load_settings

    monkeypatch.delenv("JWT_SIGNING_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://test:test@localhost/test")
    with pytest.raises(RuntimeError, match="jwt_signing_key"):
        load_settings()
    private = "short-private-key"
    monkeypatch.setenv("JWT_SIGNING_KEY", private)
    with pytest.raises(RuntimeError) as error:
        load_settings()
    assert private not in str(error.value)


def test_cookie_can_disable_secure_only_for_local_http():
    from fastapi import Response

    from app.auth.router import set_refresh_cookie

    response = Response()
    set_refresh_cookie(
        response,
        "synthetic-refresh",
        datetime.now(UTC) + timedelta(seconds=60),
        auth_settings(cookie_secure=False),
    )
    cookie = response.headers["set-cookie"]
    assert "Secure" not in cookie
    assert "HttpOnly" in cookie and "Domain=" not in cookie


@pytest.mark.parametrize(
    "key",
    [
        "abcdefghijklmnopabcdefghijklmnop",
        "aB7!cD9@eF2#gH4$aB7!cD9@eF2#gH4$",
        "2ghJj3eYC65ZV4zuLr8s-91QTNpXvWbA" * 2,
        "abcdefghijklmnopqrstuvwxyz-ABCDEF",
        "ZYXWVUTSRQPONMLKJIHGFEDCBA-1234567",
        "9876543210-ABCDEFGHIJKLMNOPQRSTUV",
        "demo-key-2ghJj3eYC65ZV4zuLr8s-91QTN",
        "sample-key-2ghJj3eYC65ZV4zuLr8s-91QTN",
        "test-key-2ghJj3eYC65ZV4zuLr8s-91QTN",
        "example-key-2ghJj3eYC65ZV4zuLr8s-91QTN",
        "short",
        "",
        "x" * 64,
    ],
)
def test_production_rejects_predictable_signing_keys(key):
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            app_env="production",
            database_url="postgresql+psycopg://test:test@localhost/test",
            jwt_signing_key=key,
            allowed_origins=["https://uni.example"],
        )


def test_production_accepts_cryptographically_generated_signing_key():
    import secrets

    key = secrets.token_urlsafe(48)
    settings = Settings(
        _env_file=None,
        app_env="production",
        database_url="postgresql+psycopg://test:test@localhost/test",
        jwt_signing_key=key,
        allowed_origins=["https://uni.example"],
    )
    assert settings.jwt_signing_key.get_secret_value() == key


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost",
        "http://localhost:5173",
        "https://uni.example",
        "https://uni.example:443",
        "https://uni.example:65535",
        "http://127.0.0.1:8000",
        "http://[::1]:5173",
        "https://[2001:db8::1]",
        "https://[::ffff:192.0.2.1]:443",
        "https://xn--e1afmkfd.xn--p1ai",
    ],
)
def test_origin_configuration_accepts_exact_http_origins(origin):
    assert auth_settings(allowed_origins=[origin]).allowed_origins == [origin]
