"""Seed isolated PostgreSQL data for the staff applications Chromium suite."""

import os
import sys
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    Application,
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
        raise SystemExit("Staff application fixtures require the isolated uni_space_test database")

    with SessionLocal.begin() as db:
        if sys.argv[1:] in (["revoke"], ["revoke-news"]):
            profile = db.scalar(
                select(StaffProfile)
                .join(User, StaffProfile.user_id == User.id)
                .where(User.login == os.environ["STAFF_APPLICATIONS_LOGIN_A"])
            )
            db.execute(
                delete(StaffPermission).where(
                    StaffPermission.staff_profile_id == profile.id,
                    StaffPermission.permission_code
                    == ("news.publish" if sys.argv[1] == "revoke-news" else "applications.review"),
                )
            )
            return

        suffix = uuid4().hex
        password = "Fictional-Staff-Application-E2E-Password"
        password_hash = PASSWORD_HASHER.hash(password)
        student = db.scalar(
            select(Student)
            .join(User, Student.user_id == User.id)
            .where(User.login == os.environ["SERVICES_TEST_LOGIN"])
        )
        dean = db.scalar(
            select(OrgUnit).where(OrgUnit.name == "Browser E2E dean services-browser-e2e")
        )
        accounting = db.scalars(select(OrgUnit).where(OrgUnit.type == "accounting")).one()
        for letter, unit, permission in (
            ("A", dean, "applications.review"),
            ("B", dean, "applications.review"),
            ("C", accounting, "applications.review"),
            ("D", dean, "students.read"),
        ):
            login = f"staff-applications-{suffix}-{letter.lower()}"
            user = User(
                login=login,
                role="staff",
                full_name=f"Fictional Reviewer {letter}",
                password_hash=password_hash,
                is_active=True,
            )
            db.add(user)
            db.flush()
            profile = StaffProfile(user_id=user.id, org_unit_id=unit.id)
            db.add(profile)
            db.flush()
            db.add(
                StaffPermission(
                    staff_profile_id=profile.id,
                    permission_code=permission,
                    scope_org_unit_id=unit.id if permission == "applications.review" else None,
                )
            )
            if letter == "A":
                db.add(
                    StaffPermission(
                        staff_profile_id=profile.id,
                        permission_code="news.publish",
                        scope_org_unit_id=unit.id,
                    )
                )
            print(f"STAFF_APPLICATIONS_LOGIN_{letter}={login}")

        leave = db.scalar(select(ServiceType).where(ServiceType.code == "academic_leave"))
        study = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        seed = []
        for _ in range(24):
            item = Application(
                student_id=student.id,
                assigned_org_unit_id=dean.id,
                service_type_id=leave.id,
                review_status="submitted",
                document_status="not_required",
                version=1,
                form_data={"basis": "family", "starts_on": "2026-10-01", "ends_on": "2026-10-31"},
                created_at=datetime(2026, 10, 1, tzinfo=UTC),
            )
            db.add(item)
            seed.append(item)
        automatic = Application(
            student_id=student.id,
            assigned_org_unit_id=dean.id,
            service_type_id=study.id,
            review_status="submitted",
            document_status="pending",
            version=1,
            form_data={"place_of_submission": "Вымышленный архив"},
        )
        accounting_service = db.scalar(
            select(ServiceType).where(ServiceType.code == "accounting_certificate")
        )
        pending = Application(
            student_id=student.id,
            assigned_org_unit_id=accounting.id,
            service_type_id=accounting_service.id,
            review_status="approved",
            document_status="pending",
            version=3,
            form_data={"purpose": "Вымышленная заявка после одобрения"},
        )
        db.add(pending)
        db.add(automatic)
        db.flush()
        print(f"STAFF_APPLICATIONS_LEGACY_ID={seed[0].id}")
        print(f"STAFF_APPLICATIONS_PENDING_ID={pending.id}")
        print(f"STAFF_APPLICATIONS_AUTOMATIC_ID={automatic.id}")
        print(f"STAFF_APPLICATIONS_PASSWORD={password}")


if __name__ == "__main__":
    main()
