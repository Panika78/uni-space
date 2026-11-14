from sqlalchemy import CheckConstraint

from app.models import StaffPermission
from app.permissions import ACADEMIC_PERMISSIONS, AuthorizationContext, PermissionCode


def test_permission_registry_matches_database_constraint():
    constraint = next(
        c
        for c in StaffPermission.__table__.constraints
        if isinstance(c, CheckConstraint) and c.name == "ck_staff_permissions_code"
    )
    codes = {part.split("'")[1] for part in str(constraint.sqltext).split(",")}
    assert codes == {code.value for code in PermissionCode}
    assert set(PermissionCode) - ACADEMIC_PERMISSIONS == {
        PermissionCode.APPLICATIONS_REVIEW,
        PermissionCode.NEWS_PUBLISH,
    }


def test_context_contract_exposes_four_roles_and_exact_permission_codes():
    schema = AuthorizationContext.model_json_schema()
    assert schema["properties"]["role"]["enum"] == ["student", "teacher", "staff", "admin"]
    assert set(schema["$defs"]["PermissionCode"]["enum"]) == {code.value for code in PermissionCode}
