from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.academics.schemas import AcademicsResponse
from app.models import AcademicTerm, CourseGroup, CourseOffering, Discipline, Student
from app.models.academics import Assessment, AssessmentGroup, AssessmentResult, FinalResult


def get_student_academics(db: Session, student: Student) -> AcademicsResponse:
    today = datetime.now(ZoneInfo("Europe/Moscow")).date()
    # one_or_none deliberately rejects overlapping terms instead of picking one.
    term = db.scalars(
        select(AcademicTerm).where(
            AcademicTerm.starts_on <= today,
            AcademicTerm.ends_on >= today,
        )
    ).one_or_none()
    if term is None:
        return AcademicsResponse(term=None, items=[])

    # Unique assignment/student makes this LEFT JOIN one-to-one. Filter the
    # student in ON, preserving ungraded assignments and their full maximum.
    scores = (
        select(
            Assessment.course_offering_id.label("offering_id"),
            func.coalesce(func.sum(AssessmentResult.score), 0).label("total_score"),
            func.sum(Assessment.max_score).label("max_score"),
            func.count(AssessmentResult.id).label("graded_assessment_count"),
            func.count(AssessmentGroup.id).label("assessment_count"),
        )
        .join(AssessmentGroup, AssessmentGroup.assessment_id == Assessment.id)
        .outerjoin(
            AssessmentResult,
            and_(
                AssessmentResult.assessment_group_id == AssessmentGroup.id,
                AssessmentResult.student_id == student.id,
            ),
        )
        .where(AssessmentGroup.group_id == student.group_id)
        .group_by(Assessment.course_offering_id)
        .subquery()
    )
    rows = db.execute(
        select(
            CourseOffering,
            Discipline,
            scores.c.total_score,
            scores.c.max_score,
            scores.c.graded_assessment_count,
            scores.c.assessment_count,
            FinalResult,
        )
        .join(Discipline, Discipline.id == CourseOffering.discipline_id)
        .join(CourseGroup, CourseGroup.course_offering_id == CourseOffering.id)
        .outerjoin(scores, scores.c.offering_id == CourseOffering.id)
        .outerjoin(
            FinalResult,
            and_(
                FinalResult.course_offering_id == CourseOffering.id,
                FinalResult.student_id == student.id,
            ),
        )
        .where(CourseGroup.group_id == student.group_id, CourseOffering.term_id == term.id)
        .order_by(Discipline.name, CourseOffering.id)
    )
    items = []
    for offering, discipline, total, maximum, graded, count, final in rows:
        grade = final.grade_value if final else None
        passed = final.passed if final else None
        items.append(
            dict(
                course_offering_id=str(offering.id),
                discipline=dict(id=str(discipline.id), name=discipline.name),
                total_score=total or 0,
                max_score=maximum or 0,
                graded_assessment_count=graded or 0,
                assessment_count=count or 0,
                attestation_type=offering.attestation_type,
                final_result=dict(
                    grade_value=grade,
                    passed=passed,
                    has_debt=grade == 2 or passed is False,
                    retake_date=final.retake_date if final else None,
                    retake_location=final.retake_location if final else None,
                ),
            )
        )
    return AcademicsResponse(
        term=dict(id=str(term.id), name=term.name, starts_on=term.starts_on, ends_on=term.ends_on),
        items=items,
    )
