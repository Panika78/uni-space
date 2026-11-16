"""Trusted operator-only entry point: python -m app.admin.bootstrap (interactive TTY)."""

import secrets
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.schemas import CreateUser
from app.admin.service import lock_administration
from app.auth.security import PASSWORD_HASHER
from app.models import AuditEvent, User


def bootstrap_admin(db: Session, *, login: str, full_name: str) -> tuple[int, str]:
    """Caller commits once, before disclosing the secret; any error rolls back everything."""
    data = CreateUser(login=login, full_name=full_name, role="admin")
    lock_administration(db)
    if db.scalar(select(User.id).where(User.role == "admin").limit(1)) is not None:
        raise ValueError("An administrator already exists; bootstrap refused")
    if db.scalar(select(User.id).where(User.login == data.login)) is not None:
        raise ValueError("Login already exists; bootstrap refused")
    password = secrets.token_urlsafe(24)
    user = User(
        login=data.login,
        full_name=data.full_name,
        role="admin",
        is_active=True,
        password_hash=PASSWORD_HASHER.hash(password),
    )
    db.add(user)
    db.flush()
    # Sole documented system event. Never weaken the authenticated audit writer.
    db.add(
        AuditEvent(
            entity_type="user",
            entity_id=user.id,
            action="create",
            actor_user_id=None,
            before_data=None,
            after_data={"role": "admin", "is_active": True},
        )
    )
    db.flush()
    return user.id, password


def main() -> int:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print(
            "Bootstrap requires a private interactive terminal; redirection refused.",
            file=sys.stderr,
        )
        return 1
    login = input("Administrator login: ")
    full_name = input("Administrator display name: ")
    from app.core.database import SessionLocal

    try:
        with SessionLocal() as db, db.begin():
            _user_id, password = bootstrap_admin(db, login=login, full_name=full_name)
    except Exception:
        # SQL errors may contain bind parameters (including hashes). Never print them.
        print(
            "Bootstrap returned no credentials. Check installation state before retrying.",
            file=sys.stderr,
        )
        return 1
    print("Save and securely transmit this password now; it cannot be retrieved again:")
    print(password)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
