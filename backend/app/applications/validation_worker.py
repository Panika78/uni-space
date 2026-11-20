"""Resource-limited subprocess entry point for uploaded document parsing."""

import resource
import sys
from pathlib import Path

VALIDATION_MEMORY_BYTES = 256 * 1024 * 1024
VALIDATION_CPU_SECONDS = 8


def main() -> int:
    resource.setrlimit(
        resource.RLIMIT_AS,
        (VALIDATION_MEMORY_BYTES, VALIDATION_MEMORY_BYTES),
    )
    resource.setrlimit(
        resource.RLIMIT_CPU,
        (VALIDATION_CPU_SECONDS, VALIDATION_CPU_SECONDS + 1),
    )
    if sys.argv[1:] == ["--report-limits"]:
        print(
            resource.getrlimit(resource.RLIMIT_AS)[0],
            resource.getrlimit(resource.RLIMIT_CPU)[1],
        )
        return 0
    from app.applications.storage import _valid_document

    if len(sys.argv) != 3 or sys.argv[2] not in {
        "application/pdf",
        "image/jpeg",
        "image/png",
    }:
        return 2
    return 0 if _valid_document(Path(sys.argv[1]), sys.argv[2]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
