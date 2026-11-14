"""Write redacted copies of the dedicated news E2E server logs."""

import argparse
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any


SECRET_FIELDS = frozenset(
    {
        "accesskey",
        "accesstoken",
        "apikey",
        "authenticationinfo",
        "authorization",
        "clientsecret",
        "cookie",
        "csrftoken",
        "idtoken",
        "password",
        "passwd",
        "passphrase",
        "proxyauthenticate",
        "proxyauthenticationinfo",
        "proxyauthorization",
        "proxycookie",
        "refreshtoken",
        "secret",
        "secretaccesskey",
        "sessionid",
        "sessiontoken",
        "setcookie",
        "setcookie2",
        "token",
        "wwwauthenticate",
        "xapikey",
        "xauthtoken",
        "xcsrftoken",
        "xidtoken",
        "xrefreshtoken",
        "xsrftoken",
    }
)
COOKIE_FIELDS = frozenset({"cookie", "proxycookie", "setcookie", "setcookie2"})
HEADER_FIELDS = frozenset(
    {
        "authenticationinfo",
        "authorization",
        "proxyauthenticate",
        "proxyauthenticationinfo",
        "proxyauthorization",
        "wwwauthenticate",
        "xapikey",
        "xauthtoken",
    }
)
ASSIGNMENT = re.compile(
    r"(?P<prefix>(?<![\w.-])(?P<quote>['\"]?)(?P<key>[a-z][a-z0-9_.-]*)"
    r"(?P=quote)\s*[:=]\s*)"
    r"(?P<value>['\"](?:\\.|[^'\"\\])*['\"]|(?:bearer|basic)\s+\S+|"
    r"[^\s,;&{}\[\]]+)",
    re.IGNORECASE,
)


def normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.casefold())


def is_secret_key(key: str) -> bool:
    normalized = normalize_key(key)
    return normalized in SECRET_FIELDS or (
        normalized.startswith("x") and normalized[1:] in SECRET_FIELDS
    )


def redact_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if is_secret_key(str(key)) else redact_json(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return value


def redact_assignment(match: re.Match[str]) -> str:
    key = match.group("key")
    if not is_secret_key(key):
        return match.group(0)

    value = match.group("value")
    quote = value[0] if value[0] in {'"', "'"} and value[-1] == value[0] else ""
    replacement = f"{quote}[REDACTED]{quote}" if quote else "[REDACTED]"
    return f"{match.group('prefix')}{replacement}"


def redact_line(line: str) -> str:
    content = line.rstrip("\r\n")
    newline = line[len(content) :]
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        pass
    else:
        return f"{json.dumps(redact_json(parsed), ensure_ascii=False)}{newline}"

    for match in ASSIGNMENT.finditer(content):
        key = match.group("key")
        value = match.group("value")
        quote = value[0] if value[0] in {'"', "'"} and value[-1] == value[0] else ""
        if (
            is_secret_key(key)
            and normalize_key(key) in COOKIE_FIELDS | HEADER_FIELDS
            and not quote
        ):
            # Header values can contain multiple space-separated fields or attributes.
            return f"{content[: match.start('value')]}[REDACTED]{newline}"

    return f"{ASSIGNMENT.sub(redact_assignment, content)}{newline}"


def sanitize_text(text: str) -> str:
    return "".join(redact_line(line) for line in text.splitlines(keepends=True))


def sanitize(text: str) -> str:
    """Redact sensitive JSON keys and common text header/key-value forms."""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    else:
        return json.dumps(redact_json(parsed), ensure_ascii=False)

    return sanitize_text(text)


def read_log(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def write_private(path: Path, text: str) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), stat.S_IRUSR | stat.S_IWUSR)
            stream.write(text)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-log", type=Path, required=True)
    parser.add_argument("--vite-log", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_private(
        args.output_dir / "news-browser-api.safe.log",
        sanitize(read_log(args.api_log)),
    )
    write_private(
        args.output_dir / "news-browser-vite.safe.log",
        sanitize(read_log(args.vite_log)),
    )


if __name__ == "__main__":
    main()
