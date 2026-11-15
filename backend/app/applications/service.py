"""Application transitions share the caller's transaction with their history."""

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.applications.schemas import ApplicationFormData, ReviewApplicationRequest
from app.models import Application, ApplicationHistory, ServiceType, Student, User
from app.permissions import require_application_review

APPLICATION_FORMS = {"study_certificate": ApplicationFormData}

REVIEW_TRANSITIONS = {
    "start_review": ({"submitted", "resubmitted"}, "in_review"),
    "approve": ({"in_review"}, "approved"),
    "reject": ({"in_review"}, "rejected"),
    "return_for_correction": ({"in_review"}, "needs_correction"),
}


def get_owned_application(db: Session, student: Student, application_id: int) -> Application:
    application = db.scalar(
        select(Application)
        .where(Application.id == application_id, Application.student_id == student.id)
        .execution_options(populate_existing=True)
    )
    if application is None:
        raise HTTPException(404, "not_found")
    return application


def update_application(
    db: Session,
    application: Application,
    *,
    expected_version: int,
    actor_user_id: int,
    from_statuses: set[str],
    to_status: str,
    comment: str | None = None,
    form_data: dict | None = None,
) -> Application:
    # A stale request is a conflict even if its intended transition is no longer valid.
    # This early classification does not replace the version predicate in UPDATE.
    if application.version != expected_version:
        raise HTTPException(409, "version_conflict")
    service = db.get(ServiceType, application.service_type_id)
    if (
        service.processing_mode != "manual"
        or application.document_status == "ready"
        or application.review_status not in from_statuses
    ):
        raise HTTPException(409, "invalid_transition")
    previous_status = application.review_status
    values = dict(
        review_status=to_status,
        version=Application.version + 1,
        updated_at=func.statement_timestamp(),
        reviewer_user_id=None if to_status == "resubmitted" else actor_user_id,
        feedback=comment if to_status in ("rejected", "needs_correction") else None,
    )
    if form_data is not None:
        values["form_data"] = form_data
    # PostgreSQL rechecks this predicate after a concurrent writer commits.
    changed = db.scalar(
        update(Application)
        .where(
            Application.id == application.id,
            Application.version == expected_version,
            Application.review_status == previous_status,
            Application.document_status != "ready",
        )
        .values(**values)
        .returning(Application)
        .execution_options(synchronize_session=False, populate_existing=True)
    )
    if changed is None:
        raise HTTPException(409, "version_conflict")
    db.add(
        ApplicationHistory(
            application_id=application.id,
            actor_user_id=actor_user_id,
            from_status=previous_status,
            to_status=to_status,
            comment=comment,
        )
    )
    db.flush()
    return changed


def review_application(
    db: Session,
    user: User,
    application_id: int,
    request: ReviewApplicationRequest,
) -> Application:
    application = require_application_review(db, user, application_id)
    from_statuses, to_status = REVIEW_TRANSITIONS[request.action]
    return update_application(
        db,
        application,
        expected_version=request.expected_version,
        actor_user_id=user.id,
        from_statuses=from_statuses,
        to_status=to_status,
        comment=request.comment,
    )


def resubmit_application(
    db: Session,
    student: Student,
    application_id: int,
    *,
    expected_version: int,
    form_data: ApplicationFormData,
) -> Application:
    application = get_owned_application(db, student, application_id)
    service = db.get(ServiceType, application.service_type_id)
    # Only the existing form contract is supported. #67 extends this dispatch
    # together with its real service schemas; unknown forms fail closed.
    form_type = APPLICATION_FORMS.get(service.code)
    if form_type is None:
        raise HTTPException(422, "validation_error")
    return update_application(
        db,
        application,
        expected_version=expected_version,
        actor_user_id=student.user_id,
        from_statuses={"needs_correction"},
        to_status="resubmitted",
        form_data=form_type.model_validate(form_data.model_dump()).model_dump(),
    )
