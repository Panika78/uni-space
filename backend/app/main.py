from fastapi import FastAPI
from pydantic import TypeAdapter

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


def custom_openapi() -> dict:
    """Expose implemented shared schemas even before domain routes are added."""
    from fastapi.openapi.utils import get_openapi

    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    schema["servers"] = [{"url": "/api/v1"}]
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
    app.openapi_schema = schema
    return schema


app.openapi = custom_openapi
