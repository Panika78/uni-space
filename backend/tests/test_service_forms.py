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


def test_accounting_purpose_is_optional_but_strict():
    assert AccountingCertificateFormData().purpose is None
    assert AccountingCertificateFormData(purpose="  For study  ").purpose == "For study"
    with pytest.raises(ValidationError):
        AccountingCertificateFormData.model_validate({"purpose": "", "assigned_org_unit_id": 1})
