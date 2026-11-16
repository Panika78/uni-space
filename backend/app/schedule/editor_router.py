"""Protected staff routes, independent of student and teacher read scopes."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, ErrorBody, ErrorDetail
from app.dependencies.database import get_db_session
from app.models import User
from app.permissions import PermissionCode, require_permission
from app.schedule.editor_schemas import (
    CatalogPage,
    CatalogParams,
    EditorLesson,
    EditorSchedule,
    EditorScheduleParams,
    ExpectedVersion,
    Id,
    LessonChange,
    LessonWrite,
)
from app.schedule.editor_service import (
    ScheduleConflict,
    get_editor_lesson,
    list_editor_catalog,
    list_editor_schedule,
    mutate_lesson,
)

router = APIRouter(
    prefix="/api/v1/staff/schedule",
    tags=["schedule-editor"],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 500)},
)
Editor = Annotated[User, Depends(require_permission(PermissionCode.SCHEDULE_EDIT))]
Database = Annotated[Session, Depends(get_db_session)]
LessonId = Annotated[Id, Path()]


def save_operation(db, user, action, **kwargs):
    try:
        result = mutate_lesson(db, user, action, **kwargs)
        db.commit()
        # #86 can consume committed events here. No notification delivery in #74.
        db.info.pop("schedule_events", None)
        return result
    except Exception as exc:
        db.rollback()
        db.info.pop("schedule_events", None)
        if isinstance(exc, ScheduleConflict):
            payload = ApiError(
                error=ErrorBody(
                    code="schedule_conflict",
                    message="Конфликт расписания",
                    details=[ErrorDetail(field=i.field, code=i.code) for i in exc.issues],
                )
            )
            return JSONResponse(status_code=409, content=payload.model_dump())
        if isinstance(exc, DBAPIError):
            code = getattr(exc.orig, "sqlstate", None)
            if code in ("55P03", "40001", "40P01", "57014"):
                raise HTTPException(409, "concurrent_change") from exc
            if code in ("23514", "23503", "23505"):
                raise HTTPException(409, "assignment_conflict") from exc
        raise


@router.get("/catalog/{kind}", response_model=CatalogPage)
def list_catalog(
    kind: Literal[
        "groups", "subgroups", "teachers", "rooms", "course-offerings", "teaching-assignments"
    ],
    params: Annotated[CatalogParams, Query()],
    user: Editor,
    db: Database,
):
    return list_editor_catalog(db, kind, params)


@router.get("/lessons", response_model=EditorSchedule)
def list_lessons(params: Annotated[EditorScheduleParams, Query()], user: Editor, db: Database):
    return list_editor_schedule(db, params)


@router.get("/lessons/{lesson_id}", response_model=EditorLesson)
def get_lesson(lesson_id: LessonId, user: Editor, db: Database):
    return get_editor_lesson(db, int(lesson_id))


@router.post("/lessons", response_model=EditorLesson, status_code=201)
def create_lesson(body: LessonWrite, user: Editor, db: Database):
    return save_operation(db, user, "create", data=body)


@router.patch("/lessons/{lesson_id}", response_model=EditorLesson)
def update_lesson(lesson_id: LessonId, body: LessonChange, user: Editor, db: Database):
    return save_operation(
        db,
        user,
        "update",
        lesson_id=int(lesson_id),
        version=body.version,
        data=LessonWrite(**body.model_dump(exclude={"version"})),
    )


@router.post("/lessons/{lesson_id}/move", response_model=EditorLesson, status_code=201)
def move_lesson(lesson_id: LessonId, body: LessonChange, user: Editor, db: Database):
    return save_operation(
        db,
        user,
        "move",
        lesson_id=int(lesson_id),
        version=body.version,
        data=LessonWrite(**body.model_dump(exclude={"version"})),
    )


@router.post("/lessons/{lesson_id}/cancel", response_model=EditorLesson)
def cancel_lesson(lesson_id: LessonId, body: ExpectedVersion, user: Editor, db: Database):
    return save_operation(db, user, "cancel", lesson_id=int(lesson_id), version=body.version)


@router.post("/lessons/{lesson_id}/restore", response_model=EditorLesson)
def restore_lesson(lesson_id: LessonId, body: ExpectedVersion, user: Editor, db: Database):
    return save_operation(db, user, "restore", lesson_id=int(lesson_id), version=body.version)
