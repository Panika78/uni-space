from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.types import Message, Receive, Scope, Send

# Fits maximum login strings even when non-BMP characters use JSON surrogate pairs.
AUTH_BODY_LIMIT = 16384


class AuthRoute(APIRoute):
    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["method"] not in self.methods:
            await super().handle(scope, receive, send)
            return

        # Bound actual ASGI bytes before FastAPI reads/parses JSON or dependencies.
        # Never append an overflowing chunk, and stop receiving immediately.
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(chunk) > AUTH_BODY_LIMIT - len(body):
                raise HTTPException(413, "request_too_large")
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        buffered = bytes(body)
        replayed = False

        async def receive_body() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return await receive()

        await super().handle(scope, receive_body, send)
