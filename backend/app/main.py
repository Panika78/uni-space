from fastapi import FastAPI
from pydantic import TypeAdapter

from app.applications.router import router as applications_router
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

settings = get_settings()

app = FastAPI(
    title="Uni Space API",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
app.add_middleware(ApiHeadersMiddleware)
install_exception_handlers(app)
app.include_router(auth_router)
app.include_router(applications_router)


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
