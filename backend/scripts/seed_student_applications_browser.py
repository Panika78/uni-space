"""Prepare historical application states for Chromium against the isolated test database."""

import sys

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    Application,
    IssuedDocument,
    OrgUnit,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    User,
)


def main() -> None:
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if settings.app_env != "test" or url.database != "uni_space_test":
        raise SystemExit("This fixture requires the isolated uni_space_test database")
    student_login, password = sys.argv[1:3]
    with SessionLocal.begin() as db:
        student_id = db.execute(
            select(Student.id)
            .join(User, User.id == Student.user_id)
            .where(User.login == student_login)
        ).scalar_one()
        if len(sys.argv) > 3:
            action, application_id = sys.argv[3:]
            application = db.execute(
                select(Application).where(
                    Application.id == int(application_id), Application.student_id == student_id
                )
            ).scalar_one()
            if action == "document-key":
                key = db.execute(
                    select(IssuedDocument.storage_key).where(
                        IssuedDocument.application_id == application.id
                    )
                ).scalar_one()
                print(key)
                return
            if action != "pending" or application.review_status != "in_review":
                raise SystemExit("Expected an in-review document application")
            application.review_status = "approved"
            application.version += 1
            return

        dean_id = db.execute(
            select(OrgUnit.id).where(OrgUnit.name == "Browser E2E dean services-browser-e2e")
        ).scalar_one()
        accounting_id = db.execute(
            select(OrgUnit.id).where(OrgUnit.type == "accounting")
        ).scalar_one()
        reviewers = []
        for suffix, unit_id in (("dean", dean_id), ("accounting", accounting_id)):
            login = f"student-applications-browser-{suffix}"
            reviewers.append(login)
            if db.scalar(select(User.id).where(User.login == login)) is not None:
                continue
            user = User(
                login=login,
                password_hash=PASSWORD_HASHER.hash(password),
                full_name=f"Fictional Applications E2E Reviewer {suffix}",
                role="staff",
                is_active=True,
            )
            db.add(user)
            db.flush()
            profile = StaffProfile(user_id=user.id, org_unit_id=unit_id)
            db.add(profile)
            db.flush()
            db.add(
                StaffPermission(
                    staff_profile_id=profile.id,
                    permission_code="applications.review",
                    scope_org_unit_id=unit_id,
                )
            )
        service_id = db.execute(
            select(ServiceType.id).where(ServiceType.code == "study_certificate")
        ).scalar_one()
        legacy = Application(
            student_id=student_id,
            service_type_id=service_id,
            review_status="submitted",
            document_status="pending",
            form_data={"place_of_submission": "Вымышленный архив MVP1"},
        )
        db.add(legacy)
        db.flush()
        print(*reviewers, legacy.id)


if __name__ == "__main__":
    main()
