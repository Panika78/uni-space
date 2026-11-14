"""Write redacted copies of the dedicated news E2E server logs."""

import argparse
import os
import re
import stat
import tempfile
from pathlib import Path


HEADER_VALUE = re.compile(
    r"(?i)\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*:\s*[^\r\n]*"
)
SECRET_FIELD = re.compile(
    r"(?i)([\"']?(?:password|passwd|passphrase|token|access_token|refresh_token|"
    r"id_token|secret|client_secret|api_key|apikey)[\"']?\s*[:=]\s*)"
    r"(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;&\]}]+)"
)


def sanitize(text: str) -> str:
    text = HEADER_VALUE.sub(lambda match: f"{match.group(1)}: [REDACTED]", text)
    return SECRET_FIELD.sub(r"\1[REDACTED]", text)


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
