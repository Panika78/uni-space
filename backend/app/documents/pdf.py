"""Deterministic, self-contained Russian PDF renderer for demonstration certificates."""

from __future__ import annotations

import io
from datetime import datetime
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AcademicTerm,
    Application,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    Program,
    ServiceType,
    Student,
    StudyGroup,
    User,
)

FONT_PATH = Path(__file__).parent / "assets" / "DejaVuSans.ttf"
DEMO_MARK = "Демонстрационный документ. Не является официальной справкой"
MOSCOW = ZoneInfo("Europe/Moscow")


def _register_font() -> None:
    if "UniSpaceDejaVu" not in pdfmetrics.getRegisteredFontNames():
        if not FONT_PATH.is_file():
            raise RuntimeError("PDF font is unavailable")
        pdfmetrics.registerFont(TTFont("UniSpaceDejaVu", str(FONT_PATH)))


def _text(value: object) -> str:
    return escape(str(value)).replace("\n", "<br/>")


def _snapshot(db: Session, application: Application, issued_number: str) -> dict:
    student = db.get(Student, application.student_id)
    user = db.get(User, student.user_id) if student else None
    group = db.get(StudyGroup, student.group_id) if student else None
    program = db.get(Program, group.program_id) if group else None
    if not all((student, user, group, program)) or not user.full_name.strip():
        raise ValueError("required student data is unavailable")
    snapshot = {
        "document_number": issued_number,
        "issued_at": datetime.now(MOSCOW).isoformat(timespec="seconds"),
        "service_code": db.get(ServiceType, application.service_type_id).code,
        "full_name": user.full_name,
    }
    code = snapshot["service_code"]
    if code == "study_certificate":
        if application.form_data.get("place_of_submission") is None:
            raise ValueError("certificate destination is unavailable")
        snapshot.update(
            {
                "group": group.name,
                "program": program.name,
                "direction": program.direction_name,
                "academic_status": student.academic_status,
                "place_of_submission": application.form_data["place_of_submission"],
            }
        )
    elif code == "academic_transcript":
        term_id = application.form_data.get("academic_term_id")
        if not isinstance(term_id, str) or not term_id.isdigit():
            raise ValueError("saved academic term is unavailable")
        term = db.get(AcademicTerm, int(term_id))
        if term is None:
            raise ValueError("saved academic term is unavailable")
        snapshot["term"] = {
            "id": str(term.id),
            "name": term.name,
            "starts_on": term.starts_on.isoformat(),
            "ends_on": term.ends_on.isoformat(),
        }
        offerings = db.execute(
            select(CourseOffering, Discipline)
            .join(Discipline, Discipline.id == CourseOffering.discipline_id)
            .join(CourseGroup, CourseGroup.course_offering_id == CourseOffering.id)
            .where(CourseOffering.term_id == term.id, CourseGroup.group_id == student.group_id)
            .order_by(Discipline.name, CourseOffering.id)
        ).all()
        subjects = []
        for offering, discipline in offerings:
            results = db.execute(
                select(Assessment, AssessmentGroup, AssessmentResult)
                .join(AssessmentGroup, AssessmentGroup.assessment_id == Assessment.id)
                .outerjoin(
                    AssessmentResult,
                    (AssessmentResult.assessment_group_id == AssessmentGroup.id)
                    & (AssessmentResult.student_id == student.id),
                )
                .where(
                    Assessment.course_offering_id == offering.id,
                    AssessmentGroup.group_id == student.group_id,
                )
                .order_by(Assessment.title, Assessment.id)
            ).all()
            final = db.scalar(
                select(FinalResult).where(
                    FinalResult.course_offering_id == offering.id,
                    FinalResult.student_id == student.id,
                )
            )
            subjects.append(
                {
                    "name": discipline.name,
                    "assessments": [
                        {
                            "title": a.title,
                            "score": result.score if result else None,
                            "max_score": a.max_score,
                        }
                        for a, _assignment, result in results
                    ],
                    "final_result": (
                        final.grade_value
                        if final and final.grade_value is not None
                        else (
                            "Зачтено"
                            if final and final.passed is True
                            else ("Не зачтено" if final and final.passed is False else None)
                        )
                    ),
                }
            )
        snapshot["subjects"] = subjects
    elif code == "accounting_certificate":
        snapshot["purpose"] = application.form_data.get("purpose")
        snapshot["example_statement"] = (
            "В рамках учебного примера задолженность по оплате обучения отсутствует. "
            "Фактические платежи и задолженность не проверялись."
        )
    else:
        raise ValueError("unsupported document service")
    return snapshot


def get_document_snapshot(db: Session, application: Application, issued_number: str) -> dict:
    """Build the minimal snapshot using only current server-side records."""
    return _snapshot(db, application, issued_number)


def render_pdf(snapshot: dict) -> bytes:
    """Render an actual searchable PDF with embedded Cyrillic font and demo watermark."""
    _register_font()
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "CertificateTitle",
        parent=styles["Title"],
        fontName="UniSpaceDejaVu",
        fontSize=17,
        leading=22,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#15324b"),
        spaceAfter=8 * mm,
    )
    body = ParagraphStyle(
        "CertificateBody",
        parent=styles["BodyText"],
        fontName="UniSpaceDejaVu",
        fontSize=10,
        leading=15,
        alignment=TA_LEFT,
        spaceAfter=3 * mm,
        wordWrap="CJK",
    )
    small = ParagraphStyle("CertificateSmall", parent=body, fontSize=8, leading=11)
    heading = ParagraphStyle(
        "SubjectHeading", parent=body, fontName="UniSpaceDejaVu", fontSize=12, leading=16
    )
    mark_style = ParagraphStyle("mark", parent=body, textColor=colors.HexColor("#a32626"))
    story = [
        Paragraph(f"<b>{DEMO_MARK}</b>", mark_style),
        Spacer(1, 5 * mm),
    ]
    code = snapshot["service_code"]
    labels = {
        "study_certificate": "Справка об обучении",
        "academic_transcript": "Выписка об успеваемости",
        "accounting_certificate": "Справка бухгалтерии",
    }
    story.append(Paragraph(labels[code], title))
    story.extend(
        [
            Paragraph(f"Номер документа: {_text(snapshot['document_number'])}", body),
            Paragraph(f"Дата выдачи: {_text(snapshot['issued_at'])}", body),
            Paragraph(f"ФИО: <b>{_text(snapshot['full_name'])}</b>", body),
        ]
    )
    if code == "study_certificate":
        status = {
            "enrolled": "обучается",
            "academic_leave": "находится в академическом отпуске",
            "expelled": "отчислен",
            "graduated": "завершил обучение",
        }.get(snapshot["academic_status"], "статус не установлен")
        story.extend(
            [
                Paragraph(f"Учебная группа: {_text(snapshot['group'])}", body),
                Paragraph(f"Образовательная программа: {_text(snapshot['program'])}", body),
                Paragraph(f"Направление подготовки: {_text(snapshot['direction'])}", body),
                Paragraph(f"Сведения об обучении: студент {status} по данным системы.", body),
                Paragraph(f"Место предоставления: {_text(snapshot['place_of_submission'])}", body),
            ]
        )
    elif code == "accounting_certificate":
        if snapshot.get("purpose"):
            story.append(Paragraph(f"Цель: {_text(snapshot['purpose'])}", body))
        story.append(Paragraph(_text(snapshot["example_statement"]), body))
    else:
        term = snapshot["term"]
        story.extend(
            [
                Paragraph(f"Учебный период: {_text(term['name'])}", body),
                Paragraph(
                    f"Период дат: {_text(term['starts_on'])} — {_text(term['ends_on'])}", body
                ),
            ]
        )
        for subject in snapshot["subjects"]:
            story.append(Paragraph(_text(subject["name"]), heading))
            rows = [["Работа", "Баллы", "Итог"]]
            for assessment in subject["assessments"]:
                score = "Не выставлено" if assessment["score"] is None else str(assessment["score"])
                rows.append(
                    [
                        Paragraph(_text(assessment["title"]), small),
                        Paragraph(f"{score} / {assessment['max_score']}", small),
                        "",
                    ]
                )
            final_text = (
                "Не выставлено"
                if subject["final_result"] is None
                else _text(subject["final_result"])
            )
            rows.append(["Итоговая оценка", "", final_text])
            table = LongTable(rows, colWidths=[92 * mm, 35 * mm, 45 * mm], repeatRows=1)
            table.setStyle(
                TableStyle(
                    [
                        ("FONTNAME", (0, 0), (-1, -1), "UniSpaceDejaVu"),
                        ("FONTSIZE", (0, 0), (-1, -1), 8),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eff4")),
                        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#aab6bf")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 5),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                        ("TOPPADDING", (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ]
                )
            )
            story.extend([table, Spacer(1, 4 * mm)])
    story.extend([Spacer(1, 8 * mm), Paragraph(DEMO_MARK, body)])
    output = io.BytesIO()

    def decorate(canvas, _document):
        canvas.saveState()
        canvas.setFont("UniSpaceDejaVu", 25)
        canvas.setFillColor(colors.Color(0.65, 0.12, 0.12, alpha=0.13))
        canvas.translate(A4[0] / 2, A4[1] / 2)
        canvas.rotate(35)
        canvas.drawCentredString(0, 0, "ДЕМО · НЕ ОФИЦИАЛЬНЫЙ ДОКУМЕНТ")
        canvas.restoreState()

    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=19 * mm,
        leftMargin=19 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=labels[code],
        author="Uni Space demo",
    )
    document.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()
