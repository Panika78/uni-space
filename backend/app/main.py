from fastapi import FastAPI
from pydantic import TypeAdapter

from app.academics.router import router as academics_router
from app.admin.router import router as admin_router
from app.applications.router import router as applications_router
from app.attendance.router import router as attendance_router
from app.auth.router import router as auth_router
from app.core.config import get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.core.schemas import (
    ApiError,
    Date,
    DateTime,
    ErrorDetail,
    Id,
    Page,
    PaginationParams,
    Ref,
)
from app.final_results import journal_router as final_results_journal_router
from app.final_results import router as final_results_router
from app.news.router import router as news_router
from app.news.staff_router import router as staff_news_router
from app.notifications import router as notifications_router
from app.permissions import router as permissions_router
from app.preferences import router as preferences_router
from app.schedule.editor_router import router as schedule_editor_router
from app.schedule.router import router as schedule_router
from app.staff_students import router as staff_students_router
from app.students import router as students_router
from app.teaching.router import router as teaching_router

settings = get_settings()

app = FastAPI(
    title="Uni Space API",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
app.add_middleware(ApiHeadersMiddleware)


class RequestBodyLimitMiddleware:
    """Bound all API request bodies even when Content-Length is absent."""

    limit_bytes = 54 * 1024 * 1024

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.application(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        raw_length = headers.get(b"content-length")
        if raw_length is not None and raw_length.isdigit() and int(raw_length) > self.limit_bytes:
            await self._too_large(send)
            return
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit_bytes:
                    raise RequestTooLarge
            return message

        try:
            await self.application(scope, limited_receive, send)
        except RequestTooLarge:
            await self._too_large(send)

    @staticmethod
    async def _too_large(send):
        import json

        body = json.dumps(
            {
                "error": {
                    "code": "request_too_large",
                    "message": "Размер запроса превышает допустимый предел",
                    "details": [],
                }
            },
            ensure_ascii=False,
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


class RequestTooLarge(Exception):
    pass


app.add_middleware(RequestBodyLimitMiddleware)
install_exception_handlers(app)
app.include_router(admin_router)
app.include_router(attendance_router)
app.include_router(auth_router)
app.include_router(preferences_router)
app.include_router(permissions_router)
app.include_router(academics_router)
app.include_router(applications_router)
app.include_router(notifications_router)
app.include_router(schedule_router)
app.include_router(schedule_editor_router)
app.include_router(students_router)
app.include_router(staff_students_router)
app.include_router(news_router)
app.include_router(staff_news_router)
app.include_router(teaching_router)
app.include_router(final_results_router)
app.include_router(final_results_journal_router)


def create_openapi_schema(application: FastAPI) -> dict:
    """Expose implemented shared schemas without rewriting route paths."""
    from fastapi.openapi.utils import get_openapi

    if application.openapi_schema:
        return application.openapi_schema
    schema = get_openapi(
        title=application.title,
        version=application.version,
        routes=application.routes,
    )
    schemas = schema.setdefault("components", {}).setdefault("schemas", {})
    definitions = {
        "ErrorDetail": ErrorDetail.model_json_schema(),
        "ApiError": ApiError.model_json_schema(),
        "Page": Page[dict[str, object]].model_json_schema(),
        "Id": TypeAdapter(Id).json_schema(),
        "Ref": Ref.model_json_schema(),
        "Date": TypeAdapter(Date).json_schema(),
        "DateTime": TypeAdapter(DateTime).json_schema(),
        "PaginationParams": PaginationParams.model_json_schema(),
    }

    def normalize_references(value: object) -> object:
        if isinstance(value, dict):
            return {
                key: (
                    item.replace("#/$defs/", "#/components/schemas/")
                    if isinstance(item, str)
                    else normalize_references(item)
                )
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [normalize_references(item) for item in value]
        return value

    for name, definition in definitions.items():
        normalized = normalize_references(definition)
        for nested_name, nested_definition in normalized.pop("$defs", {}).items():
            schemas[nested_name] = nested_definition
        schemas[name] = normalized
    application.openapi_schema = schema
    return schema


def generate_app_openapi() -> dict:
    return create_openapi_schema(app)


app.openapi = generate_app_openapi
