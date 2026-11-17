"""PDF renderer and isolated issued-file cleanup invariants."""

import io
import os
import re
import time

import pytest
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.documents import issuer, pdf, storage


def _certificate_snapshot():
    return {
        "service_code": "study_certificate",
        "document_number": "US-DEMO-123456789ABC",
        "issued_at": "2026-11-17T10:00:00+03:00",
        "full_name": "Вымышленный студент",
        "group": "Демо 1",
        "program": "Вымышленная программа",
        "direction": "Демо",
        "academic_status": "enrolled",
        "place_of_submission": "Вымышленная организация",
    }


@pytest.mark.parametrize("corruption", ["empty", "header", "xref", "truncated"])
def test_pdf_validation_rejects_invalid_rendered_bytes(corruption):
    valid = pdf.render_pdf(_certificate_snapshot())
    if corruption == "empty":
        content = b""
    elif corruption == "header":
        content = b"not a PDF document"
    elif corruption == "xref":
        content = re.sub(rb"startxref\s+\d+", b"startxref\n999999999", valid)
    else:
        content = valid[: len(valid) // 2]

    with pytest.raises((ValueError, PdfReadError)):
        issuer._validate_pdf(content, _certificate_snapshot())


def test_both_issued_document_download_routes_advertise_binary_pdf_openapi():
    from app.main import app

    schema = app.openapi()
    for path in (
        "/api/v1/applications/{id}/document",
        "/api/v1/staff/applications/{id}/document",
    ):
        response = schema["paths"][path]["get"]["responses"]["200"]
        assert response["content"]["application/pdf"]["schema"] == {
            "type": "string",
            "format": "binary",
        }


def test_pdf_is_searchable_cyrillic_multi_page_and_clearly_marked():
    snapshot = {
        "service_code": "academic_transcript",
        "document_number": "US-DEMO-123456789ABC",
        "issued_at": "2026-11-17T10:00:00+03:00",
        "full_name": "Вымышленная студентка с очень длинным именем и фамилией",
        "term": {
            "id": "3",
            "name": "Демонстрационный осенний семестр",
            "starts_on": "2026-09-01",
            "ends_on": "2027-01-31",
        },
        "subjects": [
            {
                "name": f"Демонстрационная дисциплина с длинным названием номер {i}",
                "assessments": [
                    {
                        "title": f"Практическое задание номер {j} с длинным описанием",
                        "score": 0 if j == 0 else None,
                        "max_score": 20,
                    }
                    for j in range(12)
                ],
                "final_result": 5 if i == 0 else None,
            }
            for i in range(18)
        ],
    }
    content = pdf.render_pdf(snapshot)
    reader = PdfReader(io.BytesIO(content), strict=True)
    assert content.startswith(b"%PDF-")
    assert len(reader.pages) >= 3
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert "Вымышленная студентка" in text
    assert "Демонстрационный документ. Не является официальной справкой" in text
    assert "Практическое задание номер 0" in text
    assert "0 / 20" in text
    assert "Итоговая оценка" in text
    assert "ДЕМО · НЕ ОФИЦИАЛЬНЫЙ ДОКУМЕНТ" in text


def test_pdf_uses_visible_replacement_for_characters_missing_from_embedded_font():
    snapshot = _certificate_snapshot() | {"place_of_submission": "Отдел — 東京"}
    content = pdf.render_pdf(snapshot)
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(content)).pages)

    issuer._validate_pdf(content, snapshot)
    assert "Отдел — ��" in text
    assert "\x00" not in text


def test_pdf_storage_cleanup_preserves_referenced_and_recent_objects(tmp_path):
    attachment_root = tmp_path / "private"
    root = storage.issued_root(attachment_root)
    active_key = storage.create_key()
    orphan_key = storage.create_key()
    storage.publish_bytes(
        root,
        active_key,
        pdf.render_pdf(
            {
                "service_code": "study_certificate",
                "document_number": "D-1",
                "issued_at": "2026-11-17",
                "full_name": "Студент",
                "group": "Группа",
                "program": "Программа",
                "direction": "Направление",
                "academic_status": "enrolled",
                "place_of_submission": "Демонстрация",
            }
        ),
    )
    storage.publish_bytes(root, orphan_key, b"%PDF-test orphan")
    old_time = time.time() - 7200
    os.utime(root / orphan_key, (old_time, old_time))

    removed = storage.cleanup_orphans(
        attachment_root, lambda: {active_key}, older_than_seconds=3600
    )
    assert removed == 1
    assert (root / active_key).is_file()
    assert not (root / orphan_key).exists()
    # The existing attachment cleanup only scans its own root, never this subtree.
    assert (root / active_key).is_file()
