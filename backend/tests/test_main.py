from fastapi.testclient import TestClient

from app.main import app


def test_api_docs_and_openapi_are_available() -> None:
    client = TestClient(app)

    assert client.get("/api/docs").status_code == 200
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 404
