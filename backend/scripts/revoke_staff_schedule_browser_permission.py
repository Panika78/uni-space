"""Revoke only the fictional editor grant used by the isolated browser E2E."""

import sys

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import StaffPermission, StaffProfile, User


def main() -> None:
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "uni_space_test"
        or url.password != "test-only-password"
    ):
        raise SystemExit("Refusing to change permissions outside localhost uni_space_test")
    if len(sys.argv) != 2 or not sys.argv[1].startswith("staff-schedule-"):
        raise SystemExit("Expected the isolated fictional schedule E2E login")

    with SessionLocal.begin() as session:
        user_id = session.scalar(select(User.id).where(User.login == sys.argv[1]))
        if user_id is None:
            raise SystemExit("The fictional schedule E2E user was not found")
        profile_id = session.scalar(select(StaffProfile.id).where(StaffProfile.user_id == user_id))
        if profile_id is None:
            raise SystemExit("The fictional schedule E2E staff profile was not found")
        result = session.execute(
            delete(StaffPermission).where(
                StaffPermission.staff_profile_id == profile_id,
                StaffPermission.permission_code == "schedule.edit",
            )
        )
        if result.rowcount != 1:
            raise SystemExit("Expected exactly one fictional schedule.edit grant")


if __name__ == "__main__":
    main()
