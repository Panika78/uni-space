from datetime import date

import pytest
from pydantic import ValidationError

from app.applications.schemas import (
    AcademicLeaveFormData,
    AcademicTranscriptInput,
    AccountingCertificateFormData,
    StudyCertificateFormData,
)


def test_study_certificate_keeps_required_mvp1_place_contract():
    assert (
        StudyCertificateFormData(place_of_submission="  Registry  ").place_of_submission
        == "Registry"
    )
    with pytest.raises(ValidationError):
        StudyCertificateFormData.model_validate({})
    with pytest.raises(ValidationError):
        StudyCertificateFormData.model_validate(
            {"place_of_submission": "Registry", "student_id": "1"}
        )


def test_academic_transcript_input_rejects_client_period_and_student_ids():
    assert AcademicTranscriptInput.model_validate({}).model_dump() == {}
    for forged in ({"academic_term_id": "1"}, {"student_id": "1"}, {"date": "2026-11-15"}):
        with pytest.raises(ValidationError):
            AcademicTranscriptInput.model_validate(forged)


def test_academic_leave_requires_a_valid_basis_dates_and_other_explanation():
    valid = AcademicLeaveFormData(
        basis="medical", starts_on=date(2026, 12, 1), ends_on=date(2027, 1, 1)
    )
    assert valid.basis == "medical"
    with pytest.raises(ValidationError):
        AcademicLeaveFormData.model_validate(
            {"basis": "other", "starts_on": "2026-12-02", "ends_on": "2026-12-01"}
        )
    with pytest.raises(ValidationError):
        AcademicLeaveFormData.model_validate(
            {"basis": "other", "starts_on": "2026-12-01", "ends_on": "2026-12-02"}
        )
    with pytest.raises(ValidationError):
        AcademicLeaveFormData.model_validate(
            {
                "basis": "family",
                "starts_on": "2026-12-01",
                "ends_on": "2026-12-02",
                "student_id": "1",
            }
        )


@pytest.mark.parametrize(
    ("form_data", "field"),
    [
        (
            {
                "basis": "medical",
                "starts_on": "2026-12-02",
                "ends_on": "2026-12-01",
            },
            "ends_on",
        ),
        (
            {
                "basis": "other",
                "starts_on": "2026-12-01",
                "ends_on": "2026-12-02",
            },
            "explanation",
        ),
    ],
)
def test_academic_leave_validation_errors_are_attached_to_the_field(form_data, field):
    with pytest.raises(ValidationError) as exc_info:
        AcademicLeaveFormData.model_validate(form_data)
    assert exc_info.value.errors()[0]["loc"] == (field,)


def test_create_application_422_details_identify_additional_form_fields():
    from fastapi.testclient import TestClient

    from app.dependencies.auth import get_current_student
    from app.dependencies.database import get_db_session
    from app.main import app

    app.dependency_overrides[get_current_student] = lambda: None
    app.dependency_overrides[get_db_session] = lambda: None
    cases = (
        (
            {"service_code": "accounting_certificate", "form_data": {"purpose": "\u001c"}},
            "form_data.purpose",
        ),
        (
            {
                "service_code": "academic_leave",
                "form_data": {
                    "basis": "medical",
                    "starts_on": "2026-12-02",
                    "ends_on": "2026-12-01",
                },
            },
            "form_data.ends_on",
        ),
        (
            {
                "service_code": "academic_leave",
                "form_data": {
                    "basis": "other",
                    "starts_on": "2026-12-01",
                    "ends_on": "2026-12-02",
                },
            },
            "form_data.explanation",
        ),
    )
    try:
        client = TestClient(app)
        for payload, expected_field in cases:
            response = client.post("/api/v1/applications", json=payload)
            assert response.status_code == 422, response.text
            assert response.json()["error"]["code"] == "validation_error"
            assert any(
                detail["field"] == expected_field for detail in response.json()["error"]["details"]
            )
    finally:
        app.dependency_overrides.pop(get_current_student, None)
        app.dependency_overrides.pop(get_db_session, None)


def test_accounting_purpose_is_optional_but_strict():
    assert AccountingCertificateFormData().purpose is None
    assert AccountingCertificateFormData(purpose="  For study  ").purpose == "For study"
    with pytest.raises(ValidationError):
        AccountingCertificateFormData.model_validate({"purpose": "", "assigned_org_unit_id": 1})
