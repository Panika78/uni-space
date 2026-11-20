import asyncio
import importlib.metadata
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser
from starlette.datastructures import UploadFile


@pytest.mark.parametrize(
    ("package", "fixed_version"),
    [
        ("pypdf", (6, 21, 4)),
        ("starlette", (1, 3, 1)),
        ("python-multipart", (0, 0, 31)),
    ],
)
def test_security_dependencies_are_on_fixed_versions(package, fixed_version):
    version = tuple(int(part) for part in importlib.metadata.version(package).split("."))
    assert version >= fixed_version


def test_starlette_upload_rollover_runs_outside_event_loop():
    async def exercise_rollover():
        spooled = __import__("tempfile").SpooledTemporaryFile(max_size=8)
        upload = UploadFile(spooled, size=0)
        event_loop_thread = threading.get_ident()
        rollover_thread = None
        original_rollover = spooled.rollover

        def record_rollover():
            nonlocal rollover_thread
            rollover_thread = threading.get_ident()
            original_rollover()

        spooled.rollover = record_rollover
        await upload.write(b"x" * 9)
        await upload.close()
        assert rollover_thread is not None
        assert rollover_thread != event_loop_thread

    asyncio.run(exercise_rollover())


def test_multipart_epilogue_is_processed_within_timeout():
    boundary = b"audit-boundary"
    body = (
        b'--audit-boundary\r\nContent-Disposition: form-data; name="x"\r\n\r\n'
        b"x\r\n--audit-boundary--\r\n" + b"x" * (8 * 1024 * 1024)
    )
    parser = MultipartParser(boundary, {}, max_size=len(body))
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(parser.write, body).result(timeout=2)
    assert result == len(body)


def test_multipart_rejects_excessive_part_headers():
    body = (
        b"--audit-boundary\r\n"
        + b"".join(b"X-Audit: value\r\n" for _ in range(5_000))
        + b"\r\nbody\r\n--audit-boundary--\r\n"
    )
    parser = MultipartParser(b"audit-boundary", {})
    with pytest.raises(MultipartParseError, match="header count exceeded"):
        parser.write(body)


def test_upload_validation_is_concurrent_but_does_not_block_event_loop(monkeypatch, tmp_path):
    from app.applications import router

    active = 0
    peak_active = 0
    state_lock = threading.Lock()
    release_workers = threading.Event()

    def slow_stage(_source, _filename, _root):
        nonlocal active, peak_active
        with state_lock:
            active += 1
            peak_active = max(peak_active, active)
        try:
            assert release_workers.wait(timeout=3)
            return object()
        finally:
            with state_lock:
                active -= 1

    monkeypatch.setattr(router.storage, "stage_upload", slow_stage)

    async def exercise_concurrency():
        tasks = [
            asyncio.create_task(router.stage_upload_async(None, "file.pdf", tmp_path))
            for _ in range(4)
        ]
        await asyncio.sleep(0.05)
        assert not any(task.done() for task in tasks)
        assert peak_active == 2
        release_workers.set()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)

    try:
        asyncio.run(exercise_concurrency())
    finally:
        release_workers.set()
