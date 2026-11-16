"""Fictional browser fixtures; refuse every non-isolated database."""

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import OrgUnit, Program, StudyGroup, Teacher, User

settings = get_settings()
url = make_url(settings.database_url.get_secret_value())
if (
    settings.app_env != "test"
    or url.host not in ("localhost", "127.0.0.1")
    or url.database != "uni_space_test"
    or url.username != "uni_space_test"
):
    raise SystemExit("Only isolated localhost uni_space_test is supported")
with SessionLocal.begin() as db:
    if not db.scalar(select(User.id).where(User.login == "admin-browser-operator")):
        db.add(
            User(
                login="admin-browser-operator",
                full_name="Вымышленный администратор",
                role="admin",
                is_active=True,
                password_hash=PASSWORD_HASHER.hash("Fictional-Admin-Browser-2026"),
            )
        )
    for name, kind in [
        ("Admin Browser Dean", "dean_office"),
        ("Admin Browser Accounting", "accounting"),
    ]:
        if not db.scalar(select(OrgUnit.id).where(OrgUnit.name == name)):
            db.add(OrgUnit(name=name, type=kind))
    db.flush()
    unit = db.scalar(select(OrgUnit.id).where(OrgUnit.name == "Admin Browser Dean"))
    program = db.scalar(select(Program).where(Program.code == "admin-browser"))
    if not program:
        program = Program(
            code="admin-browser",
            name="Fictional",
            direction_code="00",
            direction_name="Fictional",
            faculty_id=unit,
        )
        db.add(program)
        db.flush()
        db.add(
            StudyGroup(
                name="Admin Browser Group", program_id=program.id, course_number=1
            )
        )
    # A unique free teacher for each independent run; never duplicate a linked teacher.
    db.add_all([Teacher(full_name="Admin Browser Free Teacher") for _ in range(2)])
