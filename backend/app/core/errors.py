import logging
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.pagination import InvalidCursorError
from app.core.schemas import ApiError, ErrorBody, ErrorDetail

logger = logging.getLogger(__name__)
HTTP_ERROR_CODES = {
    401: {
        "invalid_credentials",
        "access_expired",
        "invalid_access",
        "session_invalid",
        "invalid_refresh",
    },
    403: {"forbidden", "origin_not_allowed"},
    404: {"not_found"},
    422: {"validation_error"},
    429: {"rate_limited"},
}
DEFAULT_HTTP_ERROR_CODES = {
    401: "invalid_access",
    403: "forbidden",
    404: "not_found",
    422: "validation_error",
    429: "rate_limited",
}


def _error_response(
    status_code: int,
    code: str,
    message: str,
    details: list[ErrorDetail] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    payload = ApiError(error=ErrorBody(code=code, message=message, details=details or []))
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(),
        headers=headers,
    )


def internal_error_response(exc: Exception) -> JSONResponse:
    logger.exception("Unhandled API exception", exc_info=exc)
    return _error_response(500, "internal_error", "Внутренняя ошибка сервера")


def _validation_details(errors: list[dict[str, Any]]) -> list[ErrorDetail]:
    details: list[ErrorDetail] = []
    for error in errors:
        location = [
            str(part)
            for part in error.get("loc", ())
            if part not in {"body", "query", "path", "header", "cookie"}
        ]
        details.append(
            ErrorDetail(
                field=".".join(location) or None,
                code="required" if error.get("type") == "missing" else "invalid_value",
            )
        )
    return details


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(InvalidCursorError)
    async def handle_invalid_cursor(_request: Request, _exc: InvalidCursorError) -> JSONResponse:
        return _error_response(
            422,
            "validation_error",
            "Проверьте введённые данные",
            [ErrorDetail(field="cursor", code="invalid_value")],
        )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return _error_response(
            422,
            "validation_error",
            "Проверьте введённые данные",
            _validation_details(exc.errors()),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        headers = dict(exc.headers or {})
        if exc.status_code >= 500:
            return _error_response(
                exc.status_code,
                "internal_error",
                "Внутренняя ошибка сервера",
                headers=headers,
            )

        detail = exc.detail
        allowed_codes = HTTP_ERROR_CODES.get(exc.status_code, set())
        code = detail if isinstance(detail, str) and detail in allowed_codes else None
        code = code or DEFAULT_HTTP_ERROR_CODES.get(exc.status_code, "http_error")
        try:
            message = HTTPStatus(exc.status_code).phrase
        except ValueError:
            message = "Request failed"
        return _error_response(exc.status_code, code, message, headers=headers)

    @app.exception_handler(Exception)
    async def handle_unexpected_exception(_request: Request, exc: Exception) -> JSONResponse:
        return internal_error_response(exc)
