import json
import unicodedata
from datetime import UTC, datetime
from typing import Annotated
from uuid import NAMESPACE_OID, UUID, uuid5

from fastapi import HTTPException, Request
from pydantic import Field, StrictBool, StringConstraints, ValidationInfo, field_validator
from sqlalchemy import BigInteger, Uuid, exists, func, literal, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.audit import write_audit_event
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import DateTime, Page, PaginationParams, RequestModel
from app.models import CourseGroup, Student, Teacher, TeacherAnnouncement, TeachingAssignment, User
from app.notification_events import create_domain_notifications
from app.teaching.validation import TeachingId


class TeacherAnnouncementCreate(RequestModel):
    group_id: TeachingId | None
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    body: Annotated[str, Field(min_length=1, max_length=20_000)]
    is_important: StrictBool = False

    @field_validator("title", "body", mode="before")
    @classmethod
    def validate_text(cls, value: object, info: ValidationInfo) -> object:
        allowed = "\t\r\n" if info.field_name == "body" else ""
        if isinstance(value, str) and (
            not value.strip()
            or any(
                unicodedata.category(char) in {"Cc", "Cs"} and char not in allowed for char in value
            )
        ):
            raise ValueError("Expected non-blank text containing valid Unicode")
        return value


class AnnouncementTeacher(RequestModel):
    id: TeachingId
    full_name: str


class Announcement(RequestModel):
    id: TeachingId
    course_offering_id: TeachingId
    group_id: TeachingId | None
    teacher: AnnouncementTeacher
    title: str
    body: str
    excerpt: str
    is_important: bool
    created_at: DateTime


def require_unique_query_params(request: Request) -> None:
    if len(request.query_params.multi_items()) != len(request.query_params):
        raise HTTPException(422, "validation_error")


async def require_unique_announcement_fields(request: Request) -> None:
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result = dict(pairs)
        if len(result) != len(pairs):
            raise HTTPException(422, "validation_error")
        return result

    try:
        json.loads(await request.body(), object_pairs_hook=unique_object)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(422, "validation_error") from exc


def course_groups(course_id: int):
    return select(CourseGroup.group_id).where(CourseGroup.course_offering_id == course_id)


def teacher_groups(course_id: int, teacher_id: int):
    return select(TeachingAssignment.group_id).where(
        TeachingAssignment.course_offering_id == course_id,
        TeachingAssignment.teacher_id == teacher_id,
    )


def can_publish_to_all(course_id: int, teacher_id: int):
    groups = course_groups(course_id)
    missing = groups.where(CourseGroup.group_id.not_in(teacher_groups(course_id, teacher_id)))
    return groups.exists() & ~missing.exists()


def serialize_announcement(record: TeacherAnnouncement, full_name: str) -> Announcement:
    collapsed = " ".join(record.body.split())
    return Announcement(
        id=str(record.id),
        course_offering_id=str(record.course_offering_id),
        group_id=str(record.group_id) if record.group_id is not None else None,
        teacher=AnnouncementTeacher(id=str(record.teacher_id), full_name=full_name),
        title=record.title,
        body=record.body,
        excerpt=collapsed if len(collapsed) <= 160 else collapsed[:159].rstrip() + "…",
        is_important=record.is_important,
        created_at=record.created_at,
    )


def create_announcement(
    db: Session,
    user: User,
    teacher_id: int,
    course_id: int,
    body: TeacherAnnouncementCreate,
    publication_key: UUID | None = None,
) -> Announcement:
    if publication_key is not None:
        publication_key = uuid5(NAMESPACE_OID, f"teacher-announcement:{user.id}:{publication_key}")
    group_id = int(body.group_id) if body.group_id is not None else None
    assignment = TeachingAssignment
    record_model = TeacherAnnouncement
    inserted = False
    try:
        # Lock only this teacher's assignments for the offering. A concurrent
        # revocation either completes first or waits for publication to commit.
        locked_groups = list(
            db.scalars(
                teacher_groups(course_id, teacher_id)
                .order_by(assignment.group_id)
                .with_for_update(read=True)
            )
        )
        if not locked_groups:
            raise HTTPException(403, "forbidden")

        groups = course_groups(course_id)
        all_groups = (
            groups.exists() & ~groups.where(CourseGroup.group_id.not_in(locked_groups)).exists()
        )
        if group_id is None:
            authorized = all_groups
        elif group_id in locked_groups:
            authorized = groups.where(CourseGroup.group_id == group_id).exists()
        else:
            # A partial assignment grants no visibility into other pairs.
            if db.scalar(select(all_groups)):
                raise HTTPException(422, "validation_error")
            raise HTTPException(403, "forbidden")

        values = select(
            literal(course_id, type_=BigInteger),
            literal(teacher_id, type_=BigInteger),
            literal(group_id, type_=BigInteger),
            literal(body.title),
            literal(body.body),
            literal(body.is_important),
            literal(publication_key, type_=Uuid),
        ).where(authorized)
        record = db.scalar(
            insert(record_model)
            .from_select(
                [
                    "course_offering_id",
                    "teacher_id",
                    "group_id",
                    "title",
                    "body",
                    "is_important",
                    "publication_key",
                ],
                values,
            )
            .on_conflict_do_nothing(constraint="uq_teacher_announcement_publication")
            .returning(record_model)
        )
        if record is None:
            if publication_key is None or not db.scalar(select(authorized)):
                raise HTTPException(403, "forbidden")
            record = db.scalar(
                select(record_model).where(
                    record_model.teacher_id == teacher_id,
                    record_model.publication_key == publication_key,
                )
            )
            if record is None:
                raise HTTPException(403, "forbidden")
            if (
                record.course_offering_id,
                record.group_id,
                record.title,
                record.body,
                record.is_important,
            ) != (course_id, group_id, body.title, body.body, body.is_important):
                raise HTTPException(409, "idempotency_conflict")
            response = serialize_announcement(record, user.full_name)
            db.commit()
            return response

        inserted = True
        event = write_audit_event(
            db,
            actor=user,
            entity_type="teacher_announcement",
            action="create",
            entity_id=record.id,
            before_data=None,
            after_data={
                "course_offering_id": course_id,
                "teacher_id": teacher_id,
                "group_id": group_id,
                "title": record.title,
                "is_important": record.is_important,
            },
        )
        if record.is_important:
            audience_groups = (
                {group_id} if group_id is not None else set(db.scalars(course_groups(course_id)))
            )
            memberships = (
                db.execute(
                    select(Student.user_id, Student.group_id)
                    .join(User, User.id == Student.user_id)
                    .where(
                        Student.group_id.in_(audience_groups),
                        Student.academic_status == "enrolled",
                        User.is_active.is_(True),
                    )
                    .order_by(Student.id)
                    .with_for_update(of=Student)
                ).all()
                if audience_groups
                else []
            )
            recipient_group_ids = {int(user_id): int(group_id) for user_id, group_id in memberships}
            recipient_ids = set(recipient_group_ids)
            create_domain_notifications(
                db,
                logical_event_key=f"audit:{event.id}",
                recipient_user_ids=recipient_ids,
                notification_type="important_announcement",
                title="Новое важное объявление по дисциплине",
                body="Откройте страницу дисциплины, чтобы прочитать объявление.",
                entity_type="course_offering",
                entity_ids_by_user={user_id: course_id for user_id in recipient_ids},
                audience_group_ids_by_user=recipient_group_ids,
            )
        response = serialize_announcement(record, user.full_name)
        db.commit()
        return response
    except HTTPException:
        if inserted:
            db.rollback()
        raise
    except Exception:
        db.rollback()
        raise


def list_announcements(
    db: Session, course_id: int, group_id: int, params: PaginationParams, *, scope: int
) -> Page[Announcement]:
    announcement = TeacherAnnouncement
    current_access = (
        teacher_groups(course_id, scope).where(TeachingAssignment.group_id == group_id).exists()
        if scope > 0
        else select(Student.id).where(Student.id == -scope, Student.group_id == group_id).exists()
    )
    query = (
        select(announcement, func.coalesce(User.full_name, Teacher.full_name))
        .join(Teacher, Teacher.id == announcement.teacher_id)
        .outerjoin(User, User.id == Teacher.user_id)
        .where(
            current_access,
            announcement.course_offering_id == course_id,
            or_(announcement.group_id == group_id, announcement.group_id.is_(None)),
            exists(course_groups(course_id).where(CourseGroup.group_id == group_id)),
        )
    )
    key_types = (int, int, int, str, int)
    try:
        boundary = decode_page_cursor(params.cursor, key_types=key_types, direction="desc")
        if boundary:
            if boundary[:3] != (scope, course_id, group_id) or boundary[4] <= 0:
                raise InvalidCursorError("Cursor belongs to another selection")
            timestamp = datetime.fromisoformat(boundary[3])
            if (
                timestamp.utcoffset() is None
                or timestamp.astimezone(UTC).isoformat() != boundary[3]
            ):
                raise InvalidCursorError("Invalid timestamp")
            # A forged cursor must reference a row visible to this group.
            if not db.execute(
                query.where(announcement.id == boundary[4], announcement.created_at == timestamp)
            ).first():
                raise InvalidCursorError("Invalid boundary")
            query = query.where(
                tuple_(announcement.created_at, announcement.id) < (timestamp, boundary[4])
            )
    except (ValueError, OverflowError) as exc:
        raise HTTPException(422, "validation_error") from exc
    rows = db.execute(
        query.order_by(announcement.created_at.desc(), announcement.id.desc()).limit(
            params.limit + 1
        )
    )
    return paginate_results(
        (serialize_announcement(record, name) for record, name in rows),
        key=lambda row: (scope, course_id, group_id, row.created_at.isoformat(), int(row.id)),
        key_types=key_types,
        direction="desc",
        limit=params.limit,
    )
