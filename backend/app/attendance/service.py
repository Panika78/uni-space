"""Attendance writes and audit share one transaction and parent-row locks."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.attendance.schemas import AttendanceResponse
from app.audit import write_audit_event
from app.models import Attendance, Lesson, Student, TeachingAssignment, User
from app.permissions import PermissionCode, get_authorization_context, require_staff_permission
from app.schedule.participants import get_student_lesson_condition
from app.teaching.service import list_page, require_current_teacher


def serialize_attendance(lesson, student_id, mark):
    return AttendanceResponse(
        lesson_id=str(lesson.id),
        student_id=str(student_id),
        status=mark.status if mark else "unmarked",
        lesson_status=lesson.status,
        starts_at=lesson.starts_at,
        ends_at=lesson.ends_at,
        updated_at=mark.updated_at if mark else None,
    )


def update_attendance(db: Session, user: User, lesson_id: int, student_id: int, status: str | None):
    """PUT upserts; DELETE missing row is a no-op, after all scope checks.

    Lock order: lesson, student, teaching assignment. The lesson lock serializes
    absent-row creation as well as update/delete and schedule participant edits;
    the student lock serializes transfers. Re-read after waiting for each lock.
    Commit order defines last-successful-write. Never commit before audit flush.
    """
    try:
        context = get_authorization_context(db, user)
        staff = context.role == "staff"
        if staff:
            require_staff_permission(db, user, PermissionCode.ATTENDANCE_EDIT)
        else:
            teacher_id = require_current_teacher(db, user)
        lesson = db.scalar(
            select(Lesson)
            .where(Lesson.id == lesson_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        student = db.scalar(
            select(Student)
            .where(Student.id == student_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if lesson is None or student is None:
            raise HTTPException(404, "not_found")
        current = bool(
            db.scalar(
                select(
                    get_student_lesson_condition(lesson.id, student.group_id, student.subgroup_id)
                )
            )
        )
        mark = db.get(Attendance, (lesson_id, student_id), populate_existing=True)
        if not staff:
            assignment = db.scalar(
                select(TeachingAssignment)
                .where(
                    TeachingAssignment.teacher_id == teacher_id,
                    TeachingAssignment.course_offering_id == lesson.course_offering_id,
                    TeachingAssignment.group_id == student.group_id,
                )
                .with_for_update(read=True)
            )
            same_membership = mark is None or (
                mark.origin_group_id == student.group_id
                and mark.origin_subgroup_id == student.subgroup_id
                and mark.membership_version == student.membership_version
            )
            if assignment is None or not current or not same_membership:
                raise HTTPException(404, "not_found")
        elif not current and mark is None:
            raise HTTPException(404, "not_found")
        # No roster history exists: only the latest membership boundary is kept.
        # A shared lesson or returning to an old group cannot reopen old writes.
        if mark is None and lesson.starts_at < student.membership_changed_at:
            raise HTTPException(404, "not_found")
        if not staff and lesson.status != "scheduled":
            raise HTTPException(409, "invalid_transition")
        if (
            staff
            and mark is None
            and (lesson.status != "scheduled" or lesson.starts_at > datetime.now(UTC))
        ):
            raise HTTPException(409, "invalid_transition")
        if (mark is None and status is None) or (mark is not None and mark.status == status):
            result = serialize_attendance(lesson, student_id, mark)
            db.commit()
            return result
        before = {"student_id": student_id, "status": mark.status} if mark else None
        action = "delete" if status is None else "create" if mark is None else "update"
        if status is None:
            db.delete(mark)
        else:
            if mark is None:
                mark = Attendance(
                    lesson_id=lesson_id,
                    student_id=student_id,
                    origin_group_id=student.group_id,
                    origin_subgroup_id=student.subgroup_id,
                    membership_version=student.membership_version,
                )
                db.add(mark)
            mark.status = status
            mark.marked_by_user_id = user.id
            mark.updated_at = db.scalar(select(func.clock_timestamp()))
        write_audit_event(
            db,
            actor=user,
            entity_type="attendance",
            entity_id=lesson_id,
            action=action,
            before_data=before,
            after_data={"student_id": student_id, "status": status} if status else None,
        )
        result = serialize_attendance(lesson, student_id, mark if status else None)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def get_attendance_query(student):
    return (
        select(Lesson, Attendance, Lesson.id)
        .select_from(Lesson)
        .join(Student, Student.id == student.id)
        .outerjoin(
            Attendance,
            and_(
                Attendance.lesson_id == Lesson.id,
                Attendance.student_id == Student.id,
            ),
        )
        .where(
            or_(
                get_student_lesson_condition(Lesson.id, Student.group_id, Student.subgroup_id),
                Attendance.student_id == Student.id,
            )
        )
    )


def list_student_attendance(db, student, params):
    query = get_attendance_query(student)
    if params.lesson_id is not None:
        query = query.where(Lesson.id == int(params.lesson_id))
    return list_page(
        db,
        query,
        params,
        (Lesson.id,),
        (int,),
        lambda row: serialize_attendance(row[0], student.id, row[1]),
    )


def get_student_attendance(db, student, lesson_id):
    row = db.execute(get_attendance_query(student).where(Lesson.id == lesson_id)).first()
    if row is None:
        raise HTTPException(404, "not_found")
    return serialize_attendance(row[0], student.id, row[1])
