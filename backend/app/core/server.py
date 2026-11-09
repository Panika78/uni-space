"""Launch Uvicorn with explicit, validated forwarding policy."""

import argparse
import os

from app.core.config import Settings, load_settings


def create_server_arguments(
    settings: Settings, *, host: str, port: int, reload: bool = False
) -> list[str]:
    arguments = ["uvicorn", "app.main:app", "--host", host, "--port", str(port)]
    if settings.proxy_headers_enabled:
        arguments.extend(
            ["--proxy-headers", "--forwarded-allow-ips", ",".join(settings.trusted_proxy_ips)]
        )
    else:
        arguments.append("--no-proxy-headers")
    if reload:
        arguments.append("--reload")
    return arguments


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    options = parser.parse_args()
    settings = load_settings()
    arguments = create_server_arguments(
        settings, host=options.host, port=options.port, reload=options.reload
    )
    os.execvp(arguments[0], arguments)


if __name__ == "__main__":
    main()
