from app.models.academics import Assessment, AssessmentGroup, AssessmentResult, FinalResult
from app.models.accounts import AuthSession, Notification, RefreshToken, User
from app.models.applications import Application, ApplicationHistory, ServiceType
from app.models.attendance import Attendance
from app.models.audit import AuditEvent
from app.models.base import Base
from app.models.news import News, NewsCreateRequest
from app.models.permissions import StaffPermission, StaffProfile
from app.models.preferences import UserPreferences
from app.models.schedule import (
    AcademicTerm,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    LessonRoom,
    Room,
)
from app.models.student_status_operation import StudentStatusOperation
from app.models.teaching import TeachingAssignment
from app.models.university import OrgUnit, Program, Student, StudyGroup, Subgroup, Teacher

__all__ = [
    "Attendance",
    "TeachingAssignment",
    "AuditEvent",
    "StudentStatusOperation",
    "Assessment",
    "AssessmentGroup",
    "AssessmentResult",
    "FinalResult",
    "AcademicTerm",
    "Discipline",
    "CourseOffering",
    "CourseGroup",
    "Building",
    "Room",
    "Lesson",
    "LessonGroup",
    "LessonRoom",
    "AuthSession",
    "Application",
    "ApplicationHistory",
    "Base",
    "News",
    "NewsCreateRequest",
    "Notification",
    "OrgUnit",
    "Program",
    "RefreshToken",
    "Student",
    "ServiceType",
    "StudyGroup",
    "Subgroup",
    "Teacher",
    "User",
    "UserPreferences",
    "StaffPermission",
    "StaffProfile",
]
