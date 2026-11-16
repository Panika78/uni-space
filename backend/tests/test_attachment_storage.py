import os
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from fastapi import HTTPException

from app.applications.storage import cleanup_orphans, stage_upload

PDF = b"%PDF-1.4\nvalid fictional file\n%%EOF"


def test_stages_pdf_with_private_permissions_and_rejects_spoofed_or_oversized_files(tmp_path):
    staged = stage_upload(BytesIO(PDF), "../proof.pdf", tmp_path)
    try:
        assert staged.filename == "proof.pdf"
        assert staged.mime_type == "application/pdf"
        assert staged.size_bytes == len(PDF)
        assert (tmp_path / staged.storage_key).exists() is False
        assert (tmp_path / ".staging").stat().st_mode & 0o777 == 0o700
        assert staged.stage_path.stat().st_mode & 0o777 == 0o600
    finally:
        staged.stage_path.unlink(missing_ok=True)

    with pytest.raises(HTTPException) as invalid:
        stage_upload(BytesIO(b"not a pdf"), "proof.pdf", tmp_path)
    assert invalid.value.status_code == 422

    with pytest.raises(HTTPException) as oversized:
        stage_upload(
            BytesIO(b"%PDF-1.4\n" + b"x" * (10 * 1024 * 1024) + b"%%EOF"), "large.pdf", tmp_path
        )
    assert oversized.value.status_code == 413
    assert list((tmp_path / ".staging").iterdir()) == []


def test_cleanup_is_repeatable_concurrent_and_preserves_recent_or_referenced_objects(tmp_path):
    root = tmp_path
    staging = root / ".staging"
    staging.mkdir(mode=0o700)
    stale_stage = staging / "upload-interrupted"
    stale_stage.write_bytes(b"partial")
    stale_orphan = root / f"{'a' * 32}.pdf"
    stale_orphan.write_bytes(PDF)
    current = root / f"{'b' * 32}.png"
    current.write_bytes(b"private")
    recent = root / f"{'c' * 32}.jpg"
    recent.write_bytes(b"recent")
    old_time = 1
    for path in (stale_stage, stale_orphan, current):
        os.utime(path, (old_time, old_time))

    def clean():
        return cleanup_orphans(root, {current.name})

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: clean(), range(2)))
    assert sum(results) == 2
    assert not stale_stage.exists()
    assert not stale_orphan.exists()
    assert current.exists()
    assert recent.exists()
    assert clean() == 0
