"""PDF renderer and isolated issued-file cleanup invariants."""

import io
import os
import time

from pypdf import PdfReader

from app.documents import pdf, storage


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
