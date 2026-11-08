import re
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class ApiHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        supplied_request_id = headers.get(b"x-request-id", b"").decode("latin-1")
        request_id = (
            supplied_request_id
            if REQUEST_ID_PATTERN.fullmatch(supplied_request_id)
            else str(uuid4())
        )
        response_started = False

        async def send_with_api_headers(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                response_headers = list(message.get("headers", []))
                response_headers = [
                    (key, value)
                    for key, value in response_headers
                    if key.lower() != b"x-request-id"
                ]
                response_headers.append((b"x-request-id", request_id.encode("ascii")))
                path = scope.get("path", "")
                if path == "/api/v1" or path.startswith("/api/v1/"):
                    response_headers = [
                        (key, value)
                        for key, value in response_headers
                        if key.lower() != b"cache-control"
                    ]
                    response_headers.append((b"cache-control", b"no-store"))
                message["headers"] = response_headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_api_headers)
        except Exception as exc:
            if response_started:
                raise
            from app.core.errors import internal_error_response

            response = internal_error_response(exc)
            await response(scope, receive, send_with_api_headers)
