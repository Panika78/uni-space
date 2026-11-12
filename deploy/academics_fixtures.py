"""Fictional academics fixtures, after schedule_fixtures.py, in isolated test deployments."""

from datetime import UTC, datetime

from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    Student,
    User,
)


def seed_academics_fixtures():
    with SessionLocal.begin() as db:

        def add(model, **values):
            instance = model(**values)
            db.add(instance)
            db.flush()
            return instance

        students = [
            db.scalar(
                select(Student).join(User).where(User.login == f"schedule-fixture-{i}")
            )
            for i in (1, 2)
        ]
        if any(student is None for student in students):
            raise RuntimeError("Create fictional schedule students first")
        term = db.scalar(
            select(AcademicTerm).where(AcademicTerm.name == "Тестовый текущий семестр")
        )
        if term is None:
            raise RuntimeError("Create the fictional current term first")
        for index, kind in enumerate(("exam", "pass_fail", "graded_pass", "exam")):
            discipline = add(
                Discipline, name=f"Успеваемость: тестовый предмет {index + 1}"
            )
            course = add(
                CourseOffering,
                discipline_id=discipline.id,
                term_id=term.id,
                attestation_type=kind,
            )
            for student in students:
                add(
                    CourseGroup, course_offering_id=course.id, group_id=student.group_id
                )
            if index == 0:
                for i in range(3):
                    work = add(
                        Assessment,
                        course_offering_id=course.id,
                        title=f"Работа {i}",
                        type="test",
                        max_score=10,
                    )
                    for j, student in enumerate(students):
                        assignment = add(
                            AssessmentGroup,
                            assessment_id=work.id,
                            group_id=student.group_id,
                        )
                        if i < 2:
                            add(
                                AssessmentResult,
                                assessment_group_id=assignment.id,
                                student_id=student.id,
                                score=(6 if i == 0 else 0) if j == 0 else 9,
                                graded_at=datetime.now(UTC),
                            )
            elif index == 2:
                work = add(
                    Assessment,
                    course_offering_id=course.id,
                    title="Без результатов",
                    type="seminar",
                    max_score=10,
                )
                for student in students:
                    add(
                        AssessmentGroup,
                        assessment_id=work.id,
                        group_id=student.group_id,
                    )
            if index == 0:
                add(
                    FinalResult,
                    course_offering_id=course.id,
                    student_id=students[0].id,
                    grade_value=2,
                    retake_date=term.ends_on,
                    retake_location="Тестовая аудитория 101",
                )
                add(
                    FinalResult,
                    course_offering_id=course.id,
                    student_id=students[1].id,
                    grade_value=5,
                )
            elif index == 1:
                add(
                    FinalResult,
                    course_offering_id=course.id,
                    student_id=students[0].id,
                    passed=False,
                )
                add(
                    FinalResult,
                    course_offering_id=course.id,
                    student_id=students[1].id,
                    passed=True,
                )
            elif index == 2:
                add(
                    FinalResult,
                    course_offering_id=course.id,
                    student_id=students[0].id,
                    grade_value=4,
                )


if __name__ == "__main__":
    seed_academics_fixtures()
