"""Install the approved MVP2 service type registry."""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20261115_04"
down_revision: str | Sequence[str] | None = "20261115_03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SERVICES = (
    ("study_certificate", "Справка об обучении", "automatic", True),
    ("academic_transcript", "Выписка об успеваемости", "automatic", True),
    ("academic_leave", "Академический отпуск", "manual", False),
    ("accounting_certificate", "Бухгалтерская справка", "manual", True),
)


def upgrade() -> None:
    connection = op.get_bind()
    for code, title, processing_mode, produces_document in SERVICES:
        existing = (
            connection.execute(
                sa.text(
                    "SELECT processing_mode, produces_document FROM service_types WHERE code=:code"
                ),
                {"code": code},
            )
            .mappings()
            .one_or_none()
        )
        if existing is None:
            connection.execute(
                sa.text(
                    "INSERT INTO service_types (code,title,processing_mode,produces_document) "
                    "VALUES (:code,:title,:mode,:document) ON CONFLICT (code) DO NOTHING"
                ),
                {
                    "code": code,
                    "title": title,
                    "mode": processing_mode,
                    "document": produces_document,
                },
            )
            existing = (
                connection.execute(
                    sa.text(
                        "SELECT processing_mode, produces_document FROM service_types WHERE code=:code"
                    ),
                    {"code": code},
                )
                .mappings()
                .one()
            )
        if (
            existing["processing_mode"] != processing_mode
            or existing["produces_document"] != produces_document
        ):
            raise RuntimeError(
                f"service_types.{code} conflicts with the approved immutable service registry"
            )


def downgrade() -> None:
    # Service rows may already own application history/data; retain reference data.
    pass
