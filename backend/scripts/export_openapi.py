import json
import os
import sys
from pathlib import Path

backend_path = Path(__file__).resolve().parents[1]
output_path = backend_path / "openapi.json"


def main() -> None:
    os.environ.setdefault(
        "DATABASE_URL",
        "postgresql+psycopg://openapi:placeholder@localhost/unused",
    )
    sys.path.insert(0, str(backend_path))
    from app.main import app

    generated = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if "--check" in sys.argv:
        if not output_path.exists() or output_path.read_text(encoding="utf-8") != generated:
            raise SystemExit("backend/openapi.json is stale; run the types:generate command")
    else:
        output_path.write_text(generated, encoding="utf-8")


if __name__ == "__main__":
    main()
