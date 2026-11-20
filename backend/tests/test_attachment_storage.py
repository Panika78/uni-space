import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import suppress
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.applications.storage import (
    cleanup_orphans,
    coordination_lock,
    discard,
    publish,
    stage_upload,
)

PDF = Path(__file__).with_name("fixtures").joinpath("minimal.pdf").read_bytes()


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
        discard(staged)

    with pytest.raises(HTTPException) as invalid:
        stage_upload(BytesIO(b"not a pdf"), "proof.pdf", tmp_path)
    assert invalid.value.status_code == 422

    for filename, fake_document in (
        ("spoof.pdf", b"%PDF-1.4\nfictional but invalid document\n%%EOF"),
        ("spoof.png", b"\x89PNG\r\n\x1a\nnot actually a PNG"),
    ):
        with pytest.raises(HTTPException) as invalid_document:
            stage_upload(BytesIO(fake_document), filename, tmp_path)
        assert invalid_document.value.status_code == 422

    with pytest.raises(HTTPException) as oversized:
        stage_upload(
            BytesIO(b"%PDF-1.4\n" + b"x" * (10 * 1024 * 1024) + b"%%EOF"), "large.pdf", tmp_path
        )
    assert oversized.value.status_code == 413
    assert list((tmp_path / ".staging").iterdir()) == []


def test_malformed_pdf_xref_is_rejected_within_timeout(tmp_path):
    malicious_pdf = b"%PDF-1.4\nstartxref\n28\n%%EOF\nxref\n1 0\naaa\n"
    command = (
        "from io import BytesIO; from pathlib import Path; "
        "from app.applications.storage import stage_upload; "
        f"stage_upload(BytesIO({malicious_pdf!r}), 'audit.pdf', Path({str(tmp_path)!r}))"
    )
    with pytest.raises(subprocess.CalledProcessError) as rejected:
        subprocess.run(
            [sys.executable, "-c", command],
            cwd=Path(__file__).parents[1],
            check=True,
            capture_output=True,
            timeout=5,
        )
    assert b"invalid_attachment" in rejected.value.stderr


def test_oversized_image_dimensions_are_rejected_before_decode(tmp_path, monkeypatch):
    import app.applications.storage as storage

    decoded = False

    class FakeImage:
        format = "PNG"
        size = (storage.MAX_IMAGE_PIXELS + 1, 1)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def verify(self):
            nonlocal decoded
            decoded = True

        def load(self):
            nonlocal decoded
            decoded = True

    monkeypatch.setattr(storage.Image, "open", lambda _path: FakeImage())
    with pytest.raises(HTTPException) as invalid:
        stage_upload(BytesIO(b"\x89PNG\r\n\x1a\nvalid signature"), "large.png", tmp_path)
    assert invalid.value.status_code == 422
    assert decoded is False


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


def test_cleanup_waits_for_publication_and_preserves_the_committed_reference(tmp_path):
    staged = stage_upload(BytesIO(PDF), "proof.pdf", tmp_path)
    coordinator = coordination_lock(tmp_path)
    coordinator.__enter__()
    lock_held = True
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            cleanup = executor.submit(cleanup_orphans, tmp_path, lambda: {staged.storage_key})
            with pytest.raises(TimeoutError):
                cleanup.result(timeout=0.1)
            published = publish(staged, tmp_path)
            coordinator.__exit__(None, None, None)
            lock_held = False
            assert cleanup.result(timeout=5) == 0
        assert published.read_bytes() == PDF
    finally:
        # publish closes the staging lock. The context may already be released.
        if lock_held:
            with suppress(OSError):
                coordinator.__exit__(None, None, None)
        discard(staged)


def test_cleanup_skips_a_stage_held_open_by_an_active_upload(tmp_path):
    staged = stage_upload(BytesIO(PDF), "proof.pdf", tmp_path)
    os.utime(staged.stage_path, (1, 1))
    try:
        assert cleanup_orphans(tmp_path, set(), older_than_seconds=1) == 0
        assert staged.stage_path.exists()
    finally:
        discard(staged)
