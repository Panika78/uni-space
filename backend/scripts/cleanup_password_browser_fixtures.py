"""Remove only the isolated fictional fixtures created by the password browser E2E."""

import os

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AuditEvent,
    AuthSession,
    OrgUnit,
    Program,
    RefreshToken,
    StaffProfile,
    Student,
    StudyGroup,
    Teacher,
    User,
)


def main() -> None:
    suffix = os.environ.get("PASSWORD_E2E_SUFFIX", "")
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        not suffix
        or settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "uni_space_test"
        or url.password != "test-only-password"
    ):
        raise SystemExit("Refusing to clean password browser data outside uni_space_test")

    with SessionLocal.begin() as db:
        users = list(db.scalars(select(User).where(User.login.like(f"password-%-{suffix}"))))
        user_ids = [user.id for user in users]
        session_ids = select(AuthSession.id).where(AuthSession.user_id.in_(user_ids))
        db.execute(delete(AuditEvent).where(AuditEvent.actor_user_id.in_(user_ids)))
        db.execute(
            delete(AuditEvent).where(
                AuditEvent.entity_type == "user", AuditEvent.entity_id.in_(user_ids)
            )
        )
        db.execute(delete(RefreshToken).where(RefreshToken.session_id.in_(session_ids)))
        db.execute(delete(AuthSession).where(AuthSession.user_id.in_(user_ids)))
        db.execute(delete(Student).where(Student.user_id.in_(user_ids)))
        db.execute(delete(Teacher).where(Teacher.user_id.in_(user_ids)))
        db.execute(delete(StaffProfile).where(StaffProfile.user_id.in_(user_ids)))
        db.execute(delete(User).where(User.id.in_(user_ids)))
        db.execute(delete(StudyGroup).where(StudyGroup.name == f"PASSWORD-E2E-{suffix}"))
        db.execute(delete(Program).where(Program.code == f"pw-{suffix}"))
        db.execute(delete(OrgUnit).where(OrgUnit.name.like(f"Password E2E % {suffix}")))


if __name__ == "__main__":
    main()
