from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StrictBool, StrictStr, model_validator

from app.core.schemas import Id, RequestModel
from app.permissions import PermissionCode

# Match the existing login contract; no trimming or case normalization.
Login = Annotated[StrictStr, Field(min_length=1, max_length=256)]


def validate_admin_id(value: str) -> str:
    if int(value) > 9223372036854775807:
        raise ValueError("ID exceeds BIGINT")
    return value


AdminId = Annotated[Id, Field(max_length=19), AfterValidator(validate_admin_id)]


class CreateUser(RequestModel):
    login: Login
    full_name: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    role: Literal["student", "teacher", "staff", "admin"]
    group_id: AdminId | None = None
    teacher_id: AdminId | None = None
    org_unit_id: AdminId | None = None

    @model_validator(mode="after")
    def validate_profile(self):
        expected = {"student": "group_id", "teacher": "teacher_id", "staff": "org_unit_id"}
        for field in ("group_id", "teacher_id", "org_unit_id"):
            if (getattr(self, field) is not None) != (expected.get(self.role) == field):
                raise ValueError("A matching profile is required")
        return self


class UserSummary(RequestModel):
    id: Id
    login: str
    full_name: str
    role: Literal["student", "teacher", "staff", "admin"]
    is_active: bool


class PermissionGrant(RequestModel):
    permission_code: PermissionCode
    scope_org_unit_id: AdminId | None


class UserDetail(UserSummary):
    student_id: Id | None
    group_id: Id | None
    teacher_id: Id | None
    staff_profile_id: Id | None
    org_unit_id: Id | None
    permissions: list[PermissionGrant]
    available_permission_codes: list[PermissionCode] = Field(default_factory=list)


class CreatedUser(RequestModel):
    user: UserDetail
    initial_password: str


class SetActive(RequestModel):
    is_active: StrictBool


class SetDepartment(RequestModel):
    org_unit_id: AdminId


class UserListParams(RequestModel):
    q: Annotated[str, Field(max_length=256)] = ""
    after_id: AdminId | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 20


class UserPage(RequestModel):
    items: list[UserSummary]
    next_after_id: Id | None


class LookupParams(RequestModel):
    kind: Literal["groups", "teachers", "org_units"]
    q: Annotated[str, Field(max_length=256)] = ""
    after_id: AdminId | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 20


class LookupItem(RequestModel):
    id: Id
    name: str
    type: str | None = None
    context: str | None = None


class LookupPage(RequestModel):
    items: list[LookupItem]
    next_after_id: Id | None
