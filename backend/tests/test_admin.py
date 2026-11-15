"""Operator entry point never accepts redirected secret output or public bootstrap."""

import io

from app.admin.bootstrap import main
from app.admin.schemas import CreateUser, PermissionGrant
from app.main import app


def test_bootstrap_refuses_non_interactive_terminal(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("unused-login\nunused-name\n"))
    assert main() == 1
    output = capsys.readouterr()
    assert not output.out
    assert "private interactive terminal" in output.err


def test_bootstrap_is_not_exposed_over_http():
    paths = app.openapi()["paths"]
    assert all("bootstrap" not in path and "reset" not in path for path in paths)


def test_creation_rejects_incompatible_profiles_and_permission_code():
    import pytest
    from pydantic import ValidationError

    for fields in ({}, {"group_id": "1"}, {"org_unit_id": "1", "teacher_id": "2"}):
        with pytest.raises(ValidationError):
            CreateUser(login="fictional", full_name="Fictional", role="staff", **fields)
    with pytest.raises(ValidationError):
        PermissionGrant(permission_code="invented", scope_org_unit_id=None)
    with pytest.raises(ValidationError):
        CreateUser(
            login="fictional",
            full_name="Fictional",
            role="staff",
            org_unit_id="9999999999999999999",
        )
