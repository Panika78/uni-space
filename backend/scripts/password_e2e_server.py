"""Start the API for isolated password browser tests without rate-limiting fixtures."""

import os

import uvicorn

from app.auth.router import login_rate_limiter

if os.environ.get("APP_ENV") != "test":
    raise RuntimeError("The password browser API launcher is test-only")

# The browser suite logs into several synthetic users from one loopback peer.
# Keep the shipped limiter implementation intact but raise its process-local
# test limit so the password-management scenarios do not test login throttling.
login_rate_limiter.limit = 1000

uvicorn.run(
    "app.main:app",
    host="127.0.0.1",
    port=int(os.environ.get("API_PORT", "8000")),
    access_log=False,
)
