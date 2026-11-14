# MVP2-00 — Approved cross-module decisions

Decision record for issue #59; approved by the product owner on 2026-11-14. This is a documentation-only contract. Implementation belongs to separate feature issues. Existing MVP1 REST/JSON, OpenAPI, DB schema and working service flow remain compatible.

## Academic assessment

- An assessment plan is approved outside Uni Space before the academic term for each course offering and study group. The plan fixes the assessment list, number of works, kinds and maxima. For the contest MVP2, the initial plan comes from fictional seed data. There is no planning/approval editor in MVP2.
- The teacher may enter or correct individual whole-number scores, mark attendance, set the final exam/pass result manually and reschedule an assessment or associate it with a lesson for assigned groups only. Rescheduling an assessment never changes the official lesson schedule.
- The teacher may not create, delete, archive or edit the shared definition of an assessment (title, kind, description or maximum). There is no teacher-facing or staff-facing API for altering the approved assessment structure in MVP2.
- Two groups may have different approved work sets and semester maxima. Sharing one assessment record between groups is allowed only if its shared parameters and maximum match; otherwise prepare separate assessment records. Dates may differ by group.
- Display the sum of recorded points and available maximum, preserving zero versus ungraded semantics, but never automatically derive the final grade from points. Final exam/graded pass is manually recorded on the existing 2–5 scale; pass/fail is manual.
- Approved codes for new seed data and UI: test (control/test, legacy MVP1 code), laboratory, practical, seminar, independent, extended_homework (substantial long-duration homework), exam (scored exam component, if in the plan), other. Existing test rows stay valid. A scored exam component does not replace the separate manually set final result.
- No new max_score_locked column or first-score-versus-maximum-edit race in MVP2: there is no API to edit maxima. Existing PostgreSQL rules rejecting invalid scores or destructive reassignment remain in place; do not rewrite MVP1 migrations.

## MVP2 university service forms

| Service | Inputs | Attachment policy |
|---|---|---|
| Study certificate | Keep existing required place_of_submission from MVP1 exactly as is | No attachments; automatic template PDF |
| Grade transcript | Current available academic period, resolved from authenticated student's data; no extra period selector in MVP2 | No attachments; automatic PDF |
| Academic leave | Reason: medical / family / other; requested start and end dates; additional explanation for other | At least one proof document required, according to reason; staff reviews |
| Accounting certificate | Optional purpose; demo: absence of tuition-payment debt | No attachments; staff approval before PDF |

Academic-leave requirements visible before submission: medical → medical certificate/opinion; family → document supporting family circumstances; other → document supporting the described circumstances. This is a **fictional demonstration policy**, not an exhaustive legal list of acceptable university documents. Client and backend validate presence and safe format; employee checks the content, not an automated authenticity classifier. Never use participants' genuine identity or medical files. A submission requiring files must not be shown as successful until the attachment backend is implemented.

Personal-data changes, dismissal, financial aid and other extra services remain Extended. Approval of academic leave does not change student academic status automatically; an authorized staff member updates it separately after the external order.

## Private file storage

- MVP2 storage is a private persistent Docker volume, never an ephemeral container layer. The API owns authorization and serves private blobs using opaque storage keys; no public direct links.
- A small save/read/delete abstraction allows later replacement with S3, without implementing an S3 adapter as part of MVP2. Reconsider the underlying storage only before deployment if the actual host lacks a persistent disk.
- Accepted file contents: PDF, JPEG/JPG, PNG with server-side signature/content verification. Maximum 5 current attachments per application, 10 MiB per file, 50 MiB total. Both count and sizes enforced server-side.
- Replacements are supported when an application is returned for correction. Secure cleanup of abandoned uploads, finite I/O timeouts, private backup and restore of both DB and blobs are required. Issued PDF is immutable, and downloading it cannot trigger regeneration.
- Business decisions and service fields are feature-specific; MVP2-00 does not attempt to design every endpoint in advance.

## Scope / follow-up

- Keep MVP1 functionality unchanged. Update product documents PRD.md, DB.md, ARCHITECTURE.md, UI_UX_SPEC.md consistently.
- #69: score writes/audit without a maximum-editor lock. #71: assessment-group date/lesson changes, without CRUD of approved works. #72: manual final result, unchanged. #80: journal without an assessment definition editor. #88: update E2E acceptance. #67 / #75 / #83: service forms, uploads and generated documents. #89: update whole-issue dependency gates.
- #63 does not logically need #59: existing user_preferences data model already covers its setting.
