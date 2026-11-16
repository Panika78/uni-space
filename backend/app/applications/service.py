"""Application transitions share the caller's transaction with their history."""

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import MultipleResultsFound
from sqlalchemy.orm import Session
from sqlalchemy.sql import ColumnElement

from app.applications.schemas import (
    AcademicLeaveFormData,
    AcademicTranscriptFormData,
    AcademicTranscriptInput,
    AccountingCertificateFormData,
    ReviewApplicationRequest,
    StudyCertificateFormData,
)
from app.models import (
    AcademicTerm,
    Application,
    ApplicationHistory,
    CourseGroup,
    CourseOffering,
    OrgUnit,
    Program,
    ServiceType,
    Student,
    StudyGroup,
    User,
)
from app.permissions import (
    PermissionCode,
    get_application_scope,
    get_authorization_context,
    require_application_review,
)

APPLICATION_FORMS = {
    "study_certificate": StudyCertificateFormData,
    "academic_transcript": AcademicTranscriptInput,
    "academic_leave": AcademicLeaveFormData,
    "accounting_certificate": AccountingCertificateFormData,
}
SERVICE_DETAILS = {
    "study_certificate": (
        "Подтверждает факт обучения. Укажите место предоставления.",
        ["Место предоставления"],
    ),
    "academic_transcript": (
        "Выписка по текущему учебному периоду.",
        ["Период определяется автоматически при подаче"],
    ),
    "academic_leave": (
        "Заявление рассматривается деканатом; решение не меняет статус студента автоматически.",
        [
            "Подтверждающий документ будет обязателен после подключения загрузки файлов",
            "Отправка станет доступна после подключения безопасного хранения файлов",
        ],
    ),
    "accounting_certificate": (
        "Справка без обращения к реальным финансовым данным.",
        ["Цель получения — необязательно"],
    ),
}


def get_current_academic_term(db: Session, student: Student) -> AcademicTerm | None:
    today = datetime.now(ZoneInfo("Europe/Moscow")).date()
    return db.scalars(
        select(AcademicTerm)
        .join(CourseOffering, CourseOffering.term_id == AcademicTerm.id)
        .join(CourseGroup, CourseGroup.course_offering_id == CourseOffering.id)
        .where(
            CourseGroup.group_id == student.group_id,
            AcademicTerm.starts_on <= today,
            AcademicTerm.ends_on >= today,
        )
        .distinct()
    ).one_or_none()


def resolve_dean_office(db: Session, student: Student) -> OrgUnit | None:
    group = db.get(StudyGroup, student.group_id)
    program = db.get(Program, group.program_id) if group else None
    faculty = db.get(OrgUnit, program.faculty_id) if program else None
    if faculty is None or faculty.type != "faculty":
        return None
    units = db.scalars(select(OrgUnit)).all()
    by_id = {unit.id: unit for unit in units}
    local = []
    for unit in units:
        if unit.type != "dean_office":
            continue
        parent_id = unit.parent_id
        visited = set()
        while parent_id is not None and parent_id not in visited:
            if parent_id == faculty.id:
                local.append(unit)
                break
            visited.add(parent_id)
            parent = by_id.get(parent_id)
            parent_id = parent.parent_id if parent else None
    if len(local) == 1:
        return local[0]
    if local:
        return None
    # A single root-level office is the only unambiguous university-wide setup.
    universal = [unit for unit in units if unit.type == "dean_office" and unit.parent_id is None]
    return (
        universal[0]
        if len(universal) == 1 and len([u for u in units if u.type == "dean_office"]) == 1
        else None
    )


def get_service_availability(
    db: Session, service: ServiceType, student: Student | None = None
) -> tuple[bool, str | None]:
    if service.code == "academic_leave":
        if student is not None and resolve_dean_office(db, student) is None:
            return False, "Для факультета студента не настроен единственный ответственный деканат."
        return (
            False,
            "Отправка станет доступна после подключения безопасной загрузки подтверждающих файлов.",
        )
    if service.code == "academic_transcript":
        try:
            if student is None or get_current_academic_term(db, student) is None:
                return False, "Сейчас не настроен единственный текущий учебный период."
        except MultipleResultsFound:
            return False, "Текущие учебные периоды настроены неоднозначно."
    if service.code == "accounting_certificate":
        units = db.scalars(select(OrgUnit).where(OrgUnit.type == "accounting")).all()
        if len(units) != 1 or service.responsible_org_unit_id != units[0].id:
            return False, "Ответственное подразделение бухгалтерии не настроено однозначно."
    return True, None


def validate_and_store_form(
    db: Session,
    service: ServiceType,
    data: dict,
    *,
    student: Student,
    existing: dict | None = None,
) -> tuple[dict, int | None]:
    form_type = APPLICATION_FORMS.get(service.code)
    if form_type is None:
        raise HTTPException(422, "validation_error")
    try:
        parsed = form_type.model_validate(data)
    except Exception as exc:
        raise HTTPException(422, "validation_error") from exc
    assigned_org_unit_id = None
    if service.code == "academic_leave":
        unit = resolve_dean_office(db, student)
        if unit is None:
            raise HTTPException(409, "responsible_unit_unavailable")
        raise HTTPException(409, "service_unavailable")
    if service.code == "academic_transcript":
        try:
            term = get_current_academic_term(db, student) if existing is None else None
        except MultipleResultsFound as exc:
            raise HTTPException(409, "academic_term_ambiguous") from exc
        if existing is not None:
            term_id = existing.get("academic_term_id")
            if not term_id:
                raise HTTPException(409, "academic_term_unavailable")
            term = db.get(AcademicTerm, int(term_id))
            if term is None:
                raise HTTPException(409, "academic_term_unavailable")
            try:
                saved_form = AcademicTranscriptFormData.model_validate(existing)
            except Exception as exc:
                raise HTTPException(409, "academic_term_unavailable") from exc
            return saved_form.model_dump(mode="json"), None
        if term is None:
            raise HTTPException(409, "academic_term_unavailable")
        return AcademicTranscriptFormData(
            academic_term_id=str(term.id),
            academic_term_name=term.name,
            starts_on=term.starts_on,
            ends_on=term.ends_on,
        ).model_dump(mode="json"), None
    if service.code == "accounting_certificate":
        units = db.scalars(select(OrgUnit).where(OrgUnit.type == "accounting")).all()
        if len(units) != 1 or service.responsible_org_unit_id != units[0].id:
            raise HTTPException(409, "service_unavailable")
        assigned_org_unit_id = units[0].id
    return parsed.model_dump(mode="json"), assigned_org_unit_id


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
    access_predicate: ColumnElement[bool],
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
            access_predicate,
            Application.version == expected_version,
            Application.review_status == previous_status,
            Application.document_status != "ready",
        )
        .values(**values)
        .returning(Application)
        .execution_options(synchronize_session=False, populate_existing=True)
    )
    if changed is None:
        # A failed conditional write may mean access was lost, not just a stale
        # version. Select only an accessible ID with a fresh READ COMMITTED
        # snapshot; do not classify using the previously loaded ORM instance.
        accessible_id = db.scalar(
            select(Application.id).where(Application.id == application.id, access_predicate)
        )
        if accessible_id is None:
            raise HTTPException(404, "not_found")
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
    context = get_authorization_context(db, user)
    scopes = [
        int(permission.scope_org_unit_id)
        for permission in context.permissions
        if permission.permission_code == PermissionCode.APPLICATIONS_REVIEW
        and permission.scope_org_unit_id is not None
    ]
    if not scopes:
        raise HTTPException(403, "forbidden")
    from_statuses, to_status = REVIEW_TRANSITIONS[request.action]
    return update_application(
        db,
        application,
        expected_version=request.expected_version,
        actor_user_id=user.id,
        access_predicate=get_application_scope().in_(scopes),
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
    form_data: dict,
) -> Application:
    application = get_owned_application(db, student, application_id)
    service = db.get(ServiceType, application.service_type_id)
    # Only the existing form contract is supported. #67 extends this dispatch
    # together with its real service schemas; unknown forms fail closed.
    stored_form, _assigned_org_unit_id = validate_and_store_form(
        db, service, form_data, student=student, existing=application.form_data
    )
    return update_application(
        db,
        application,
        expected_version=expected_version,
        actor_user_id=student.user_id,
        access_predicate=Application.student_id == student.id,
        from_statuses={"needs_correction"},
        to_status="resubmitted",
        form_data=stored_form,
    )
