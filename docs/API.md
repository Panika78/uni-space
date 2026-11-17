# API-контракт — Uni Space

> **Статус:** принят.
> **Область:** MVP 1.
> **Версия:** 1.0.
> **Дата:** 2026-11-08.
> **Базовый путь:** `/api/v1`.
> **Связанные документы:** [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DB.md](DB.md).

Документ фиксирует согласованный контракт frontend и backend. Уточняет предварительный перечень API в ARCHITECTURE.md. После реализации схемы и ответы фиксируются в OpenAPI FastAPI; TypeScript-типы генерируются из него. Реализация и OpenAPI должны соответствовать этому контракту.

## 1. Общие правила

| Параметр | Контракт |
|---|---|
| Формат | JSON, поля `snake_case` |
| ID | Строки с положительным целым: `"123"` |
| Даты / время | `YYYY-MM-DD` / ISO 8601 UTC; расписание отображается в `Europe/Moscow` |
| Пустые значения | `null`; пустые коллекции — `[]` |
| Авторизация | Bearer access; refresh — cookie; logout — cookie с необязательным Bearer fallback |
| Личные данные | Определяются по авторизации; `student_id` от клиента не принимается |
| Совместимость | Клиент игнорирует новые поля ответа; сервер отклоняет неизвестные поля запроса |

Все поля ответа присутствуют. Nullable-поля явно обозначены через `| null`. TypeScript ниже — компактная запись схем JSON, а не код реализации; `Date` и `DateTime` означают строки, не JavaScript Date.

## 2. Эндпоинты MVP 1

Пути относительно `/api/v1`.

| Метод | Путь | Вход | Успешный ответ |
|---|---|---|---|
| POST | `/auth/login` | `LoginRequest` | `200 TokenResponse` + cookie |
| POST | `/auth/refresh` | Refresh cookie, без тела | `200 TokenResponse` + новая cookie |
| POST | `/auth/logout` | Refresh cookie, необязательный Bearer fallback, без тела | `200 LogoutResponse`, cookie удалена |
| POST | `/auth/password` | `ChangePasswordRequest`, активная сессия | `204`, cookie удалена, все сессии отозваны |
| GET | `/users/me` | — | `200 StudentProfile` |
| GET | `/schedule` | `date_from`, `date_to` | `200 ScheduleResponse` |
| GET | `/academics` | — | `200 AcademicsResponse` |
| GET | `/services` | — | `200 {items: Service[]}` |
| POST | `/applications` | `CreateApplicationRequest` | `201 Application` |
| GET | `/applications` | `limit`, `cursor` | `200 Page<Application>` |
| GET | `/applications/{id}` | ID | `200 Application` |
| GET | `/applications/{id}/document` | ID заявки | готовый PDF владельцу |
| POST | `/applications/{id}/document/retry` | ID заявки | `200 Application` и метаданные документа |
| POST | `/applications/{id}/document/process` | ID старой automatic заявки | `200 Application` и метаданные документа |
| GET | `/staff/applications/{id}/document` | ID + `applications.review` scope | готовый PDF |
| POST | `/staff/applications/{id}/document/retry` | ID + `applications.review` scope | `200 StaffApplicationResponse` |

Автоматические `study_certificate` и `academic_transcript` фиксируются как
`approved` с историей до синхронной генерации. При ошибке выдачи заявка остаётся
одобренной с `document_status=failed`; потеря ответа создания требует проверки
списка/детали и не является основанием повторно отправлять POST. Ручное одобрение
`accounting_certificate` сохраняет `200` и запускает генерацию после commit.
Ответы заявки содержат `document: null | {id, filename, issued_at}` без storage key
и файлового URL. Метаданные присутствуют при `ready`; ошибка генерации не откатывает
одобрение. Для `ready` повтор — no-op над теми же байтами.

Для `academic_leave` `POST /applications` принимает только `multipart/form-data` с
полем `form_data` (JSON-строка) и одним или несколькими полями `files`.
Старый JSON-контракт остальных услуг сохранён; JSON-подача академического отпуска
отклоняется как `422 attachment_required`. Поддерживаются PDF/JPG/PNG: до 5 текущих
файлов, до 10 МиБ каждый и 50 МиБ суммарно. Минимум один технически корректный файл
обязателен при любом основании; смысловое соответствие документа сервер не оценивает.
Метаданные вложений не содержат `storage_key`. В списке и detail доступны только
текущие вложения.

| GET | `/applications/{id}/attachments` | ID заявки | `200 AttachmentMetadata[]` |
| GET | `/applications/attachments/{attachment_id}/download` | ID вложения | бинарный файл |
| GET | `/staff/applications/{id}/attachments` | ID заявки + scope | `200 AttachmentMetadata[]` |
| GET | `/staff/applications/attachments/{attachment_id}/download` | ID вложения + scope | бинарный файл |
| GET | `/news` | `limit`, `cursor` | `200 Page<NewsPreview>` |
| GET | `/news/{id}` | ID | `200 News` |
| GET | `/notifications` | `limit`, `cursor` | `200 Page<Notification>` |

Все операции, кроме auth, требуют Bearer. Студенческие операции доступны только студенту. Создание заявки возвращает также `Location` с её API-путём.

## 3. Схемы данных

### Общие типы

```ts
type Id = string;
type Date = string;      // YYYY-MM-DD
type DateTime = string;  // ISO 8601 UTC
type Ref = { id: Id; name: string };

type Page<T> = {
  items: T[];
  next_cursor: string | null;
};
```

### Авторизация и профиль

```ts
type LoginRequest = {
  login: string;
  password: string;
};

type ChangePasswordRequest = {
  current_password: string;
  new_password: string;    // 12–128 Unicode code points
  confirm_password: string;
};

`/auth/password` доступен любой активной роли. Пароли не обрезаются; новый пароль
должен содержать 12–128 Unicode code points, подтверждение должно совпадать,
категории символов не навязываются. Неверный действующий пароль — `401
invalid_credentials`, повтор действующего пароля — `409 password_unchanged`.
Ответ `204` удаляет активную refresh-cookie; при COMMIT отзываются все сессии и
refresh пользователя и создаётся безопасное audit-событие. При сетевой ошибке
клиент не повторяет запрос и отправляет пользователя ко входу, поскольку COMMIT
мог состояться без доставленного ответа.

type TokenResponse = {
  access_token: string;
  token_type: "bearer";
  expires_in: number; // секунды
};

type StudentProfile = {
  id: Id;            // ID пользователя
  student_id: Id;
  login: string;
  full_name: string;
  faculty: Ref;
  program: { id: Id; code: string; name: string };
  direction: { code: string; name: string };
  group: Ref;
  course_number: number;
  academic_status:
    | "enrolled" | "academic_leave" | "expelled" | "graduated";
};
```

### Расписание

```ts
type LessonPosition = {
  id: Id;
  starts_at: DateTime;
  ends_at: DateTime;
  status: "scheduled" | "cancelled" | "moved";
};

type Lesson = LessonPosition & {
  course_offering: {
    id: Id;
    discipline: Ref;
  };
  kind: "lecture" | "seminar" | "lab" | "other";
  teacher: Ref | null;
  groups: Ref[];
  rooms: { id: Id; name: string; building: Ref }[];
  previous_lesson: LessonPosition | null;
  latest_lesson: LessonPosition | null;
};

type ScheduleResponse = {
  date_from: Date;
  date_to: Date;
  timezone: "Europe/Moscow";
  items: Lesson[];
};
```

MVP2-10 сохраняет этот JSON-контракт. Список фильтруется по актуальной группе
и формальной подгруппе авторизованного студента. NULL подгруппы студента даёт
только общие занятия группы; NULL в назначении означает всю группу. Две подгруппы
одного занятия не дублируют `groups`. Параметры выбора чужого студента, группы
или подгруппы (`student_id`, `group_id`, `subgroup_id`) запрещены (422).
Каждая возвращаемая связанная позиция проверяется тем же предикатом участников;
недоступная позиция — `null`, без ID и времени. Обход цепочки может пройти через
чужую промежуточную позицию, чтобы найти доступный конец, но не раскрывает её.
Справочник подгрупп и защищённый read-контракт редактора относятся к #74.

`previous_lesson` — непосредственный предшественник. `latest_lesson` — последняя запись цепочки для старого перенесённого занятия; иначе `null`. Связанные позиции возвращаются даже за пределами запрошенных дат.

### Успеваемость

```ts
type AcademicsResponse = {
  term: { id: Id; name: string; starts_on: Date; ends_on: Date } | null;
  items: {
    course_offering_id: Id;
    discipline: Ref;
    total_score: number;
    max_score: number;
    graded_assessment_count: number;
    assessment_count: number;
    attestation_type: "exam" | "pass_fail" | "graded_pass";
    final_result: {
      grade_value: 2 | 3 | 4 | 5 | null;
      passed: boolean | null;
      has_debt: boolean;
      retake_date: Date | null;
      retake_location: string | null;
    };
  }[];
};
```

Суммы считаются по назначениям работ текущей группы в данном проведении дисциплины. Нет оценок — `total_score: 0`. Максимум включает неоценённые работы. `graded_assessment_count` — число назначений с выставленным результатом, включая ноль; `assessment_count` — число всех назначений.

Для экзамена и дифференцированного зачёта заполняется `grade_value`, для зачёта — `passed`. Отсутствие результата не считается долгом. `has_debt` определяется неудовлетворительным результатом: `grade_value = 2` либо `passed = false`. При отсутствии результата и сведений о пересдаче объект `final_result` всё равно присутствует: nullable-поля равны `null`, `has_debt = false`.

### Услуги и заявки

```ts
type Service = {
  id: Id;
  code: "study_certificate" | "academic_transcript" | "academic_leave" | "accounting_certificate";
  title: string;
  description: string;
  processing_mode: "automatic" | "manual";
  produces_document: boolean;
  action_available: boolean;
  unavailable_reason: string | null;
  requirements: string[];
};

type CreateStudyCertificateRequest = {
  service_code: "study_certificate";
  form_data: { place_of_submission: string };
};
type CreateAcademicTranscriptRequest = {
  service_code: "academic_transcript";
  form_data: Record<string, never>; // academic_term_id запрещён во входе
};
type CreateAcademicLeaveRequest = {
  service_code: "academic_leave";
  form_data: { basis: "medical" | "family" | "other"; starts_on: Date; ends_on: Date; explanation?: string | null };
};
type CreateAccountingCertificateRequest = {
  service_code: "accounting_certificate";
  form_data: { purpose?: string | null };
};
type CreateApplicationRequest = CreateStudyCertificateRequest | CreateAcademicTranscriptRequest
  | CreateAcademicLeaveRequest | CreateAccountingCertificateRequest; // discriminator: service_code
type AcademicTranscriptFormData = {
  academic_term_id: Id; academic_term_name: string; starts_on: Date; ends_on: Date;
}; // только сохранённая форма ответа; период выбирается сервером по группе студента
type AcademicLeaveFormData = {
  basis: "medical" | "family" | "other"; starts_on: Date; ends_on: Date; explanation: string | null;
};
type AccountingCertificateFormData = { purpose: string | null };
type AttachmentMetadata = {
  id: Id;
  original_filename: string;
  mime_type: "application/pdf" | "image/jpeg" | "image/png";
  size_bytes: number;
};

type Application = {
  id: Id;
  version: number; // версия для изменяющих запросов MVP2
  service: Service;
  form_data: { place_of_submission: string } | AcademicTranscriptFormData
    | AcademicLeaveFormData | AccountingCertificateFormData;
  review_status:
    | "submitted" | "in_review" | "needs_correction"
    | "resubmitted" | "approved" | "rejected";
  document_status: "not_required" | "pending" | "ready" | "failed";
  feedback: string | null;
  attachments: AttachmentMetadata[]; // только текущие вложения академического отпуска
  created_at: DateTime;
  updated_at: DateTime;
};
```

`study_certificate` сохраняет контракт MVP1: `place_of_submission` обязателен, 1–300 символов после trim. Для выписки входная форма пуста, сохранённый период определяется сервером из текущих периодов, связанных с группой студента через `course_groups` и `course_offerings`; при нуле или нескольких применимых периодах возвращается `409 academic_term_unavailable` или `409 academic_term_ambiguous`. При resubmit период сохраняется прежним.

Академический отпуск подаётся через `multipart/form-data`: поле `form_data` содержит JSON формы, а `files` — подтверждающие файлы PDF/JPG/PNG. Допускается не более 5 текущих файлов размером до 10 МиБ каждый и 50 МиБ суммарно; требуется минимум один технически открываемый файл. Содержимое не сверяется с основанием. Доступность и требования возвращаются в `Service`. Бухгалтерская справка принимает необязательную цель, ответственное подразделение назначается сервером. Неизвестные поля и клиентские ID/статусы запрещены.

Создание `study_certificate` и `academic_transcript` возвращает `201 approved` и запускает синхронную выдачу PDF после отдельной фиксации системного одобрения. При сбое выдачи ответ сохраняет `approved/failed` (или контролируемую ошибку при недоступности БД/хранилища); клиент не должен повторять POST создания, а проверяет заявку. `accounting_certificate` создаётся как `submitted/pending` и выдаётся только после ручного одобрения бухгалтерией. `academic_leave` остаётся отдельным процессом сотрудника без PDF и автоматического изменения академического статуса. Ошибки конфигурации — `409 service_unavailable`, `academic_term_unavailable`, `academic_term_ambiguous`, `responsible_unit_unavailable`; ошибки формы — `422 validation_error`.

### Новости и уведомления

```ts
type NewsPreview = {
  id: Id;
  title: string;
  excerpt: string;
  published_at: DateTime;
};

type News = NewsPreview & {
  body: string; // обычный текст с переносами строк
};

type Notification = {
  id: Id;
  type: string; // расширяемый машинный код; неизвестный отображается как общий
  title: string;
  body: string;
  created_at: DateTime;
};
```

`NewsPreview.excerpt` вычисляется из `body` при чтении: Unicode whitespace
схлопывается в один пробел, крайние пробелы удаляются; до 180 Unicode code
points, включая завершающий символ `…` только при сокращении. Полный `body`
не изменяется и возвращается как обычный текст с исходными переносами строк.

Статус прочтения и контекстные переходы остаются для MVP 2.

## 4. Выборки и ограничения

| Область | Правило |
|---|---|
| Пагинация | `limit`: 20 по умолчанию, 1–100; `cursor` непрозрачный |
| Конец списка | `next_cursor: null` |
| Порядок | Заявки/уведомления: `created_at DESC, id DESC`; новости: `published_at DESC, id DESC` |
| Расписание | Обе даты обязательны и включены; диапазон 1–31 день; выбираются пересекающие его занятия |
| Порядок занятий | `starts_at ASC, id ASC`; отменённые и перенесённые включены |
| Успеваемость | Текущий период по московской дате; если его нет — `term: null, items: []`; пересечение периодов — ошибка конфигурации |
| Каталог | Только доступные услуги; сортировка по `code` |
| Новости | Только опубликованные, с `published_at` не позже текущего момента |

## 5. Ошибки

Единая схема:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Проверьте введённые данные",
    "details": [
      {
        "field": "form_data.place_of_submission",
        "code": "required"
      }
    ]
  }
}
```

| HTTP | Коды |
|---|---|
| 401 | `invalid_credentials`, `access_expired`, `invalid_access`, `session_invalid`, `invalid_refresh` |
| 403 | `forbidden`, `origin_not_allowed` |
| 404 | `not_found` — одинаково для отсутствующей и чужой записи |
| 413 | `request_too_large` — тело auth-запроса превышает 16384 байта |
| 422 | `validation_error` — поля, даты, параметры, cursor |
| 429 | `rate_limited` + `Retry-After` |
| 500 | `internal_error`, без внутренних подробностей |

`details` всегда массив; клиент принимает решения по `code`, не по тексту. Каждый ответ содержит `X-Request-ID`.
Для форм заявлений `details[].field` указывает путь `form_data.<поле>`; проверка
порядка дат академического отпуска относится к `form_data.ends_on`, а отсутствие
обязательного пояснения для основания `other` — к `form_data.explanation`.

## 6. Авторизация и клиентское поведение

- Refresh cookie: `__Host-uni_space_refresh`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, без `Domain`. Сервер принимает только ровно одну cookie нового имени; повторяющиеся значения отклоняются как `401 invalid_refresh`.
- При переходе с `uni_space_refresh` старое значение не используется для refresh, login-ротации или logout-идентификации. Login/logout очищают старую host-only cookie с прежним `Path=/api/v1/auth`; оставшаяся parent-domain cookie игнорируется. После обновления пользователь входит заново, старая refresh-сессия истекает по обычному TTL.
- Для `development`/`test` при `COOKIE_SECURE=false` применяется отдельная cookie `uni_space_refresh_dev` с `Path=/api/v1/auth`, чтобы сохранить локальную работу по HTTP; production всегда требует Secure и `__Host-`.
- Login, refresh и logout ограничивают тело 16384 байтами до разбора JSON, включая потоковую передачу без `Content-Length`; превышение — `413 request_too_large`. Небольшое непустое тело refresh/logout — `422 validation_error`.
- Auth проверяет `Origin`; ответы с токенами и персональные ответы имеют `Cache-Control: no-store`.
- Успешный login отзывает только существующую сессию, которую идентифицирует текущая refresh-cookie, затем создаёт новую. Неверные credentials старую сессию не отзывают; независимые устройства не затрагиваются.
- Logout сначала ищет сессию по refresh-cookie, включая известную использованную/истёкшую cookie. Найденная сессия имеет приоритет даже при Bearer другой сессии: один запрос не отзывает две независимые сессии.
- Если cookie отсутствует или не идентифицирует сессию, logout может использовать необязательный `Authorization: Bearer <access_jwt>`. JWT проверяется существующим валидатором (подпись/HS256, claims, issuer/audience, exp/iat/nbf, token_type); sid выбирается вместе с проверкой user_id == sub. Истёкший, невалидный Bearer и несовпадение владельца не дают права отзыва.
- Logout всегда удаляет cookie и возвращает `{ session_revoked: boolean }`: `true`, если cookie или проверенный Bearer указали на конкретную сессию (в том числе уже отозванную), иначе `false`. Отзыв атомарно фиксируется под `SELECT ... FOR UPDATE`; при отсутствии пригодных идентификаторов операция остаётся идемпотентной без отзыва. Access не обязателен: cookie-only клиент совместим.
- Frontend до очистки сохраняет доступный access только во временной переменной и отправляет его на фиксированный внутренний logout с `redirect: 'error'`. Устаревшее поколение не отправляет logout новой авторизации. Только `session_revoked: true` подтверждает отзыв; `false` оставляет локальный вход заблокированным до явного нового login. Последующий успешный login отзывает текущую cookie-сессию перед созданием новой.
- Access хранится только в памяти приложения. Сроки access и сессии, проверка JWT, отзыв и ротация определяются ARCHITECTURE.md и DB.md.
- Refresh координируется между вкладками и не повторяется автоматически после сетевой ошибки.
- Исходный запрос повторяется один раз только после `401 access_expired` и успешного refresh. Login, refresh и logout после сетевой ошибки автоматически не повторяются.
- При потере ответа создания заявки клиент проверяет список, не отправляет заявку повторно автоматически.
- При logout и смене аккаунта очищается персональный кеш; запоздавшие ответы предыдущей авторизации не применяются.

## 7. Источники подхода

Соглашения адаптированы для uni-space; схемы предметных данных определены проектом.

- [Google AIP-158: Pagination](https://google.aip.dev/158).
- [Microsoft Graph: Error responses](https://learn.microsoft.com/en-us/graph/errors).
- [OpenAPI Specification](https://spec.openapis.org/oas/).

## Контекст авторизации MVP2-01

`GET /api/v1/auth/context` — защищённый read-only API для всех четырёх ролей.
Без query-параметров (неизвестные — 422), без выбора чужого пользователя.
Ответ `200`, `Cache-Control: no-store`:

```ts
type AuthorizationContext = {
  user_id: Id;
  role: "student" | "teacher" | "staff" | "admin";
  org_unit_id: Id | null;
  permissions: {
    permission_code: PermissionCode;
    scope_org_unit_id: Id | null;
  }[];
};
```

`PermissionCode` — перечисление из [AUTH.md](AUTH.md#основа-rbac-mvp2-01-60),
также представленное в OpenAPI. `permissions` — эффективные явно выданные
полномочия сотрудника после проверки роли, типа подразделения и области;
не исходные строки БД. Student/teacher/admin возвращают `[]` и `org_unit_id=null`;
их собственные предметные операции определяются существующими студенческими
проверками / преподавательскими назначениями (#61) / административными API (#78).
Пустой список не отменяет студенческий доступ к собственным данным.
Список отсортирован по коду и ID разрешения. Ответ не содержит JWT, сведений
о других пользователях, заявлений или полного справочника подразделений.
Каждый вызов читает текущую БД: отзыв, смена роли/подразделения или блокировка
действуют при следующем запросе со старым JWT. Ошибки 401/422/500 используют
общий `ApiError`. UI не может использовать этот ответ вместо серверной проверки.
`GET /users/me` и login/refresh/logout сохраняют прежние контракты.

## MVP2-03: защищённое чтение преподавательского журнала

Все маршруты ниже — `GET /api/v1/teaching`, Bearer обязателен. Источник
scope — только `teaching_assignments` через `teachers.user_id` действующего
аккаунта с ролью `teacher`. Назначения проверяются в БД на каждом запросе;
отзыв действует со следующим запросом, включая ранее выданный JWT.
`lessons.teacher_id`, факультет, кафедра и staff permissions scope не расширяют.

Базовый путь журнала `J = /courses/{course_offering_id}/groups/{group_id}`:

| Путь после `/teaching` | Ответ | Дополнительные фильтры |
|---|---|---|
| `/assignments` | `Page<TeachingAssignmentResponse>` | `course_offering_id`, `group_id`, `term_id` |
| `J/students` | `Page<JournalStudent>` | `student_id` |
| `J/assessments` | `Page<JournalAssessment>` | `assessment_group_id` |
| `J/assessments/{assessment_group_id}/results` | `Page<JournalResult>` | `student_id` |
| `PUT J/assessments/{assessment_group_id}/results/{student_id}` | `ScoreWriteResponse` | JSON `{"score": number \| null}` |
| `J/lessons` | `Page<JournalLesson>` | `lesson_id`, `starts_from`, `starts_before`, `status` |
| `J/lessons/{lesson_id}/students` | `Page<JournalStudent>` | `student_id` |
| `J/lessons/{lesson_id}/attendance` | `Page<JournalAttendanceRow>` | `student_id` |

Все списки принимают `limit=20` (1–100), непрозрачный `cursor` и возвращают
`items`, `next_cursor` без общего количества. Назначения и работы сортируются
по числовому `id ASC`; студенты и результаты — по русскому алфавиту
`А … Е, Ё, Ж … Я` без учёта регистра, затем по числовому `student_id ASC`
при совпадающих нормализованных ФИО; занятия — по `starts_at ASC,
id ASC`. Пагинация keyset, SQL ограничен `limit + 1`, scope и фильтры применяются
до пагинации. Курсор следует использовать с тем же маршрутом и фильтрами;
перенос курсора не предоставляет доступ к другим данным. Интервал занятий —
`starts_from <= starts_at < starts_before`, ISO 8601 с часовым поясом; обе
границы необязательны, при одновременной передаче правая должна быть больше.
`status`: `scheduled`, `cancelled`, `moved`; по умолчанию видны все статусы.
Неизвестные параметры, неверные ID/курсор/интервал дают `422 validation_error`.
Teaching ID в path и фильтрах — каноническая десятичная строка в диапазоне
`1..9223372036854775807`, без знака и ведущих нулей, не длиннее 19 символов.
Проверка выполняется до SQL, включая запросы авторизации; общий `Id` и MVP1
не меняются.

Ключ ФИО формируется в SQL встроенным `translate`: оба регистра 33 русских
букв отображаются в последовательные Unicode-ранги с отдельной позицией Ё;
латинские A–Z приводятся к a–z, остальные символы сохраняют кодовые точки.
`COLLATE "C"` применяется к этому ключу, а не к исходному ФИО. SQL ORDER BY,
keyset-граница, курсор и Python-проверка порядка используют один и тот же
ключ и `student_id`. Зависимости от ICU или установленной русской локали нет;
требуется штатная UTF-8 БД. Курсоры ФИО имеют префикс ключа `ru-v1:`;
курсоры прежнего технического порядка возвращают 422 — клиент начинает
выборку заново. Поля ответов и формат общего Page не меняются.

Схемы полей и nullable-значения определены в OpenAPI (`backend/openapi.json`),
клиентские типы генерируются в `frontend/src/shared/api/schema.ts`:

- Назначение содержит `id`, `course_offering_id`, `discipline`, `term`, `group`
  (последние три — `Ref`) и `attestation_type`.
- Студент: `id`, `full_name`, `subgroup_id`, `academic_status`. Roster включает
  всех текущих студентов `students.group_id`, без фильтра по академическому
  статусу. Контактные данные и идентификатор аккаунта не выдаются.
- Работа: `id` **равен `assessment_groups.id`**, отдельно `assessment_id`,
  `title`, `type`, `description`, `max_score`, `planned_date`, `lesson_id`,
  `date_needs_confirmation`. Выдаются существующие заранее утверждённые работы;
  связь с парой подгруппы не ограничивает список результатов.
- Результаты: текущий roster плюс студенты с сохранённым результатом этой
  работы после перевода, без дубликатов; `student_id`, `full_name`, `result_id`,
  `score`, `graded_at`, `is_current_group_member`. Отсутствующий результат —
  `result_id/score/graded_at=null`; выставленный `score=0` остаётся нулём.
  Результаты других назначений работ и текущая группа переведённого студента
  не раскрываются. Отдельного исторического roster нет.

Запись результата принимает целое `score` в диапазоне `0..max_score`; `null`
очищает запись. Отсутствующий результат при `null` остаётся отсутствующим.
Преподаватель должен иметь действующее назначение и студент должен сейчас
состоять в группе работы. Сотрудник деканата с эффективным `grades.edit` может
исправить или очистить существующий исторический результат; создание для
бывшего участника дополнительно блокируется PostgreSQL. Повторное значение —
no-op, без смены автора/времени и audit event. Все фактические изменения
сохраняются с `assessment_result/create|update|delete` в одной транзакции.
Структура assessment и `max_score` через этот API не изменяются.
Если PostgreSQL lock timeout не позволяет безопасно дождаться блокировки,
endpoint возвращает `503 temporarily_unavailable` с `Retry-After: 1`; повторный
запрос заново проверяет полномочия и актуальное состояние.
- Занятие: `id`, `starts_at`, `ends_at`, `kind`, `status`, `is_additional`,
  `version`. Список дедуплицирован через `EXISTS lesson_groups`. Не выдаёт
  остальные группы совместной пары, ссылки на переносы или чужие журналы.
  Участники — текущие студенты выбранной группы, соответствующие её назначениям
  `lesson_groups`: вся группа либо объединение формальных подгрупп по #62.
  Студент без подгруппы участвует только в занятии всей группы.
- Чтение посещаемости занятия: `student_id`, `full_name`, `subgroup_id`,
  `academic_status`, `status`, `updated_at`, `can_edit`. Список использует тот же
  русский keyset-порядок `ru-v1:` и SQL `limit + 1`; отсутствующая отметка имеет
  `status="unmarked"` и `updated_at=null`. Доступны только актуальные участники
  выбранной группы занятия. Сохранённая отметка показывается как текущая только
  при совпадении `origin_group_id`, `origin_subgroup_id` и `membership_version`
  с актуальным членством; иначе ответ для доступного в roster студента содержит
  `unmarked`, а `can_edit=false`. Таким образом, перевод и возвращение не
  раскрывают старую отметку как текущую. `can_edit` — снимок write-условий: пара
  должна быть `scheduled`, уже начаться, студент должен сейчас участвовать, а
  существующая отметка — соответствовать исходному периоду; для создания также
  требуется, чтобы начало пары было не раньше `membership_changed_at`. PUT/DELETE
  независимо повторно проверяют все условия. Ответ помечен
  `Cache-Control: no-store`; чужое назначение, дисциплина, занятие или группа возвращают
  `404 not_found`.

Ошибки используют общий `ApiError`: `401 invalid_access/session_invalid` при
отсутствующей/недействительной сессии или неактивном аккаунте; `403 forbidden`
для другой роли либо отсутствующего teacher profile; `404 not_found` для
неназначенной пары и отсутствующего/чужого вложенного объекта. Учитель без
назначений получает пустой `/assignments`, прямой журнал — `404`.
Чужие ID в фильтрах дают пустую выборку; не раскрываются число записей и курсоры
чужих данных. Ответы имеют `Cache-Control: no-store`.

Для #69/#70/#71/#72/#80 использовать эти идентификаторы и общий
`require_teaching_assignment`; новые write-сценарии должны дополнительно
проверять свою предметную целостность и использовать аудит #87. Этот контракт
не предоставляет права записи, не создаёт attendance и не меняет расчёт MVP1.
## Workflow заявлений MVP2-15

Маршруты относительно `/api/v1`; все требуют Bearer. Студенческие маршруты
MVP1 сохранены, в ответы создания/списка/деталей добавлено обязательное `version`.
Создание нового заявления по-прежнему не требует `expected_version` и создаёт
реальное событие `null → submitted` вместе с заявлением. Для существовавших
заявлений история начинается с первого реального действия после обновления.

| Метод | Путь | Вход | Ответ 200 |
|---|---|---|---|
| GET | `/staff/applications` | `limit`, `cursor` | `Page<StaffApplicationResponse>` |
| GET | `/staff/applications/{id}` | ID | `StaffApplicationResponse` |
| POST | `/staff/applications/{id}/review` | `ReviewApplicationRequest` | `StaffApplicationResponse` |
| GET | `/staff/applications/{id}/history` | `limit`, `cursor` | `Page<ApplicationHistoryEvent>` |
| POST | `/applications/{id}/resubmit` | `ResubmitApplicationRequest` | `Application` |
| GET | `/applications/{id}/history` | `limit`, `cursor` | `Page<ApplicationHistoryEvent>` |
| GET | `/applications/{id}/document` | ID владельца | готовый PDF |
| POST | `/applications/{id}/document/retry` | ID владельца | `Application` |
| POST | `/applications/{id}/document/process` | ID старой automatic заявки | `Application` |
| GET | `/staff/applications/{id}/document` | ID + доступный scope | готовый PDF |
| POST | `/staff/applications/{id}/document/retry` | ID + доступный scope | `StaffApplicationResponse` |

Для академического отпуска `POST /applications/{id}/resubmit` принимает JSON или
`multipart/form-data`: `expected_version`, JSON-строку `form_data`, JSON-строку
`keep_attachment_ids` с ID оставляемых **текущих** файлов и новые `files`.
Сервер под блокировкой сверяет владельца, статус и версию, проверяет квоты итогового
набора и наличие хотя бы одного файла, затем одной транзакцией обновляет форму,
актуальный состав, версию, статус и `application_history`. Неизвестные или устаревшие
ID приводят к `409`; прежний набор остаётся текущим при любой ошибке. Смена основания
сама по себе не требует нового файла.

Ошибки для загрузки: `401`, `403`, `404`, `409`, `413 request_too_large`,
`422 attachment_required`, `422 invalid_attachment`, `422 attachment_limit_exceeded`,
`503 temporarily_unavailable`. Скачивание авторизуется на каждом запросе, возвращает
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` и
`Cache-Control: no-store`. Неизвестный или чужой ID вложения возвращает одинаковый `404`.

PDF доступен только владельцу или сотруднику с действующим `applications.review`
в scope заявки. GET никогда не запускает генерацию. При `approved + pending/failed`
явный retry синхронно выдаёт документ; повтор `ready` возвращает прежние metadata.
`POST /applications/{id}/document/process` один раз фиксирует переход только для
старых automatic заявок `submitted/pending`, сохраняет прежний ID и добавляет
реальное событие истории. Для `approved/ready` endpoint является безопасным
no-op и возвращает существующую заявку, не запуская issuer. Состояния
`approved/pending`, `approved/failed` и прочие запрещённые состояния возвращают
`409`; для них используется endpoint retry. `academic_leave` PDF не выдаёт. PDF передаётся как
`application/pdf` с `Content-Disposition: inline`, `nosniff` и `no-store`; отсутствие
или повреждение файла при `ready` возвращает `503` без повторной генерации.
Детали заявки и списки включают только безопасные metadata. Пользовательские
уведомления о готовности будут подключаться отдельно в #86.

Студенческий интерфейс доработки использует JSON для бухгалтерской справки и
multipart для академического отпуска. При первом открытии формы в
`keep_attachment_ids` включаются все текущие вложения. При неизвестном исходе
отправки клиент сначала перечитывает деталь и историю, сохраняя локальные поля
и файлы. Архив использует страницы `GET /applications` и защищённый бинарный
запрос для выданного PDF.


`StaffApplicationResponse` расширяет `Application` полями `student_id: Id` и
`reviewer_user_id: Id | null`. Список заявлений сортируется по `(created_at, id)`
убывающе, история — по `(created_at, id)` возрастающе; пагинация SQL/cursor,
по умолчанию 20, максимум 100. Неизвестные/повторные query-параметры запрещены.

```ts
type ReviewApplicationRequest = {
  expected_version: number; // строго целое 1..2147483647
  action: "start_review" | "approve" | "reject" | "return_for_correction";
  comment?: string | null; // trim, 1..3000 символов; обязательна причина двух отказных действий
};
// Академический отпуск передаёт form_data и вложения как multipart/form-data.
type ResubmitApplicationRequest = {
  expected_version: number;
  form_data: { place_of_submission: string } | Record<string, never> | AcademicLeaveFormData | AccountingCertificateFormData;
};
type ApplicationHistoryEvent = {
  id: Id;
  actor_user_id: Id | null;
  from_status: Application["review_status"] | null;
  to_status: Application["review_status"];
  comment: string | null;
  created_at: DateTime;
};
```

Допустимые ручные переходы: `start_review` — `submitted/resubmitted → in_review`,
затем `approve/reject/return_for_correction` — соответственно
`approved/rejected/needs_correction`. Студент-владелец может атомарно отправить
исправленную форму ручной услуги только из `needs_correction → resubmitted` с прежним ID.
Неизвестные поля формы запрещены; сервер проверяет форму по коду услуги и сохраняет
ID заявления. Автоматические услуги (включая выписку) возвращают `409 invalid_transition`;
их сохранённая форма и история остаются без изменений. Схема входа выписки не принимает
период от клиента, а проверка сохранённой формы не вычисляет его заново. Академический
отпуск поддерживает атомарную повторную подачу с сохранением выбранных текущих файлов
и добавлением новых вложений.
Тестовые ручные услуги не входят в seed.

`reviewer_user_id` берётся из авторизации при рассмотрении/решении; сотрудники
одного разрешённого подразделения могут продолжить рассмотрение друг друга.
Повторная отправка сбрасывает назначение и текущий `feedback`, сохраняя причину
в истории. Решение, форма, версия, `updated_at` и событие фиксируются одной
транзакцией. Устаревшая версия — `409 version_conflict`; недопустимое действие,
автоматическая услуга или выданный документ — `409 invalid_transition`.
В обоих случаях история/форма/поля решения не меняются. Клиент перечитывает
состояние; автоматический повтор изменения с новой версией недопустим.

Без авторизации — `401`, без действующего `applications.review` — `403`;
чужой/несуществующий ID — одинаковый `404`. Сотрудник ограничен эффективной
областью #60: назначенное подразделение приоритетнее ответственного подразделения
услуги; отсутствие обоих закрывает доступ. Студент видит только собственные
заявления/историю. Условный UPDATE также проверяет владельца (ресабмит) либо
эффективное подразделение в разрешённых сервером областях (рассмотрение).
Конкурентная потеря доступа к объекту возвращает `404`, в том числе если одновременно
изменилась версия; если после неуспешного UPDATE объект остаётся доступен —
`409 version_conflict`. История и бизнес-поля при отказе не изменяются.
Это не сериализует одновременный отзыв разрешения в `staff_permissions`:
отзыв права/смена подразделения сотрудника действуют на следующий запрос.
Ошибки формы, причины и версии — `422 validation_error`. Общая форма — `ApiError`.

Для `study_certificate` и `academic_transcript` переход `submitted → approved`
фиксируется системой с `actor_user_id=NULL` и историей до отдельной транзакции
генерации PDF; ручное одобрение для этих автоматических услуг запрещено.
`accounting_certificate` требует реального одобрения сотрудником бухгалтерии.
`academic_leave` остаётся отдельным ручным процессом без PDF. Академический
статус студента не меняется при одобрении заявления.
Изменение набора вложений при повторной подаче академического отпуска фиксируется
в той же транзакции и увеличивает версию заявления. #83 сохраняет отдельную
транзакцию генерации и её проверки; #84/#85 используют эти API, текущую
версию и обработку 409, без выбора серверного актора/подразделения клиентом.

## Публикация университетских новостей MVP2-23

Студенческие `GET /news` и `GET /news/{id}` остаются доступными только
авторизованному студенту и возвращают только уже опубликованные новости.
Управление выполняется отдельным API только активным сотрудником с текущим
эффективным `news.publish` в его текущем подразделении.

| Метод | Путь | Вход | Успешный ответ |
|---|---|---|---|
| GET | `/staff/news` | `limit`, `cursor` | `Page<StaffNews>` |
| GET | `/staff/news/{id}` | — | `StaffNews` |
| POST | `/staff/news` | `NewsContent`, `Idempotency-Key` | `201 StaffNews`; точный повтор возвращает сохранённый результат с `200` |
| PATCH | `/staff/news/{id}` | `NewsUpdate` (`NewsContent` + `version`) | `StaffNews`; устаревшая версия — `409` |
| POST | `/staff/news/{id}/publish` | — | `StaffNews` |
| POST | `/staff/news/{id}/unpublish` | — | `StaffNews` |

`StaffNews` возвращает `id`, `title`, `body`, `author_user_id: Id | null`,
`published_at: DateTime | null`, `is_published` и положительную `version`. Null автора сохраняется для
исторических строк MVP1, у которых автора нет.

`NewsContent` содержит только `title` и `body`, неизвестные поля запрещены. `NewsUpdate`
дополнительно требует текущую `version`; каждый изменивший запись update/publish/unpublish
увеличивает её. Повтор `Idempotency-Key` привязан к сотруднику и текущему подразделению;
другое содержимое для того же ключа отклоняется с `409`.
Заголовок обрезается по краям и ограничен 1–200 Unicode-символами; текст —
1–20 000 символов, не может состоять только из пробелов. NUL и некорректные
суррогатные символы запрещены; переносы строк сохраняются. Создание создаёт
черновик, `author_user_id` задаётся сервером и сохраняется. Редактирование не
меняет состояние публикации и не сдвигает дату публикации. `publish` и
`unpublish` явные операции; повторное действие без изменения — no-op.

Список редактора включает черновики, опубликованные и снятые публикации,
сортируется по ID убывающе с keyset cursor, limit по умолчанию 20 и максимум 100.
Ошибки используют `ApiError`: `401`, `403`, `404`, `409`, `422`, `500`. Аудит
`news/create|update|publish|unpublish` фиксируется атомарно с новостью.

## Предпочтение расписания MVP2-14

`GET /api/v1/users/me/preferences` и `PATCH /api/v1/users/me/preferences`
требуют действующий Bearer и работают только с текущим аккаунтом, для любой
авторизованной роли. Ответ: `{ "show_cancelled_lessons": true }`;
при отсутствии записи GET возвращает `true` без создания строки.
PATCH принимает ровно одно обязательное поле `show_cancelled_lessons` типа boolean,
сохраняет его атомарно в `user_preferences` и возвращает подтверждённое значение.
Неизвестные ключи (включая `user_id`), отсутствие поля, строки, числа и `null`
возвращают стандартный `422 validation_error`; недействующая сессия — `401`.
Пути для чтения или изменения предпочтений другого пользователя нет.
Ответы используют общий `Cache-Control: no-store`. Контракт расписания не меняется.

## MVP2-06: подтверждение дат утверждённых работ

Чтение — существующий `J/assessments` из #61. Запись:
`PATCH /api/v1/teaching/courses/{course_offering_id}/assessments/{assessment_id}/dates`.
`assessment_id` — общая работа, элементы используют `assessment_groups.id` из чтения.

```json
{"items":[{"assessment_group_id":"123","planned_date":"2026-09-02","lesson_id":null}]}
```

От 1 до 100 уникальных назначений одной работы, все поля элемента обязательны.
Дата — YYYY-MM-DD или NULL; lesson_id — BIGINT string или NULL. Пропущенная связь
не означает неявную отвязку. Каждый элемент явно подтверждает дату (в том числе
отсутствие даты), поэтому сервер устанавливает `date_needs_confirmation=false`;
клиент не задаёт флаг. Ответ `200`: `items` с теми же тремя полями и
`date_needs_confirmation`, в порядке ID назначения. Неизменённые элементы — no-op.

Только актуальный teacher scope #61 для **каждого** назначения. Чужая/неизвестная
работа, цель или связь с занятием — одинаковый `404`; другая роль — `403`.
Связь допустима с scheduled-парой того же проведения и группы, включая её
подгруппу. Дата должна совпасть с starts_at в Europe/Moscow. Несогласованная
дата, NULL-дата при связи, отменённая/перенесённая пара, дубли/лишние поля — `422`.
Для другой даты требуется явно передать NULL-связь или подходящую новую пару.
Все элементы и аудит сохраняются атомарно. Конфликт блокировки/транзакции —
`409 version_conflict` (перечитать и повторить всё действие), без частичного успеха.
Отдельных версий дат нет; действует последнее успешно сохранённое изменение.
Официальные занятия, структура работ, максимумы и результаты не изменяются.


## Ручные итоги аттестации MVP2 (#72)

Bearer обязателен. `R = /api/v1/final-results/courses/{course_offering_id}/students/{student_id}`.
GET возвращает один итог; POST/PATCH сохраняют переданные поля; DELETE удаляет
всю запись, включая пересдачу. Все успешные операции возвращают 200 и актуальный
объект: `result_id` (nullable), `course_offering_id`, `student_id`, `grade_value`,
`passed`, `retake_date`, `retake_location`, `has_debt`. Отсутствующая строка
возвращается с nullable-полями null и has_debt=false.

Тело POST/PATCH содержит только `grade_value`, `passed`, `retake_date`,
`retake_location`. Пропущенное поле сохраняется; явный null очищает поле.
Снятие итога — PATCH с null в поле оценки: известная пересдача сохраняется.
Если все четыре поля пусты, строка удаляется. DELETE предназначен для явного
удаления также и пересдачи. Повторное сохранение/удаление без изменения — no-op.
Вид аттестации берётся с сервера: exam/graded_pass — строго целые 2–5,
pass_fail — строго boolean; второе поле результата должно быть null.
Положительный итог автоматически очищает дату и место пересдачи.
Дата — YYYY-MM-DD, место — 1–200 символов простого текста, без управляющих
и служебных Unicode-символов, пустого или пробельного значения.

Преподавателю нужны актуальные роль, профиль и назначение на проведение и
текущую группу студента, входящую в course_groups. После перевода внутри
проведения доступ получает назначенный преподаватель новой группы. Старый
преподаватель теряет его. Staff нужен эффективный grades.edit деканата без
факультетного ограничения; разрешена корректировка исторической строки.
Создавать новый итог можно только студенту текущей группы данного проведения.
Admin учебных прав не получает. Недоступные объекты дают одинаковый 404,
роль без учебных полномочий — 403, невалидные данные — 422.
Конкурентные изменения выполняются последовательно; исчерпание повторов при
конфликте БД — 409 concurrent_change, клиент может повторить всю операцию.

`GET /api/v1/teaching/courses/{course_offering_id}/groups/{group_id}/final-results`
возвращает Page с теми же объектами для текущего roster, включая невыставленные
итоги. Фильтр student_id, limit/cursor и порядок студентов совпадают с #61.
Исторические студенты чужой текущей группы не включаются. Staff использует
точечный GET R для необходимого чтения при корректировке; студент — /academics.

### MVP2-25: администрирование пользователей

Все `/api/v1/admin/*` требуют действующую сессию и актуальную роль `admin`;
остальные роли получают 403 до поиска объекта. Несуществующий объект — 404.
ID — положительные BIGINT-строки. Неизвестные поля тела/параметров списка запрещены.
Ответы `Cache-Control: no-store`. Публичного bootstrap/reset/set_role endpoint нет.

| Метод и путь | Вход / результат |
|---|---|
| GET `/admin/users` | `q` (логин/ФИО, буквальный регистронезависимый поиск), `limit=20` (1–100), `after_id`; `{items,next_after_id}` в порядке ID |
| GET `/admin/lookups` | `kind=groups|teachers|org_units`, `q`, `limit`, `after_id`; ограниченный список вариантов профиля, teachers только свободные |
| GET `/admin/users/{id}` | логин, ФИО, роль, активность, ID профиля/группы/подразделения, permissions; никаких секретов |
| POST `/admin/users` | `login`, `full_name`, `role`, ровно соответствующий роли `group_id` / `teacher_id` / `org_unit_id`; admin без профиля. 201 `{user,initial_password}` |
| POST `/admin/users/{id}/password-reset` | только другой пользователь; `{password}` с `Cache-Control: no-store`; 192 случайных бита, выдать один раз |
| PUT `/admin/users/{id}/active` | `{is_active:boolean}`; блокировка отзывает все сессии/refresh, разблокировка требует нового входа |
| PUT `/admin/users/{id}/department` | `{org_unit_id}`; все прежние grants удаляются атомарно |
| PUT / DELETE `/admin/users/{id}/permissions` | `{permission_code,scope_org_unit_id}`; grant/revoke отдельного разрешения, результат — деталь пользователя |

Password reset дополнительно требует ровно один разрешённый `Origin`, действующую
Bearer-сессию и актуальную серверную роль `admin`; пользовательский plaintext во
входе отсутствует. Для teacher имя берётся из выбранной свободной записи; существующие назначения
не меняются. Student создаётся с `academic_status=enrolled`, без подгруппы.
Staff создаётся без разрешений. Роль и логин существующего аккаунта
через этот API не меняются; пароль меняется только отдельным reset endpoint.
Учебные PermissionCode допустимы только у деканата
с NULL scope; `applications.review` / `news.publish` — со scope своего подразделения.

409: `login_exists`, `teacher_unavailable`, `self_block_forbidden`, `self_reset_forbidden`, `password_unchanged`, `last_admin`,
`conflict` (конфликт ограничений). 422: `invalid_profile`,
`invalid_permission_scope`, `validation_error`. No-op не создаёт аудит.
Создание аккаунта/профиля, grants, перевод, отзыв сессий и аудит атомарны.

`initial_password` генерирует сервер (192 случайных бита), хранится только Argon2id.
Он возвращается только в одном успешном POST-ответе, не восстанавливается через GET.
UI не помещает его в query cache/storage/history и удаляет при закрытии/уходе.
При потерянном/неразбираемом ответе или 5xx после отправки POST повтор не выполняется:
проверить список по уникальному логину. Неизвестный пароль нельзя восстановить
Сброс пароля выполняется отдельным POST и не повторяется автоматически даже после
`401 access_expired`; потерянный ответ не раскрывает и не восстанавливает пароль.
Администратор может выполнить новый осознанный сброс после проверки с пользователем.
Административный reset атомарно меняет только `password_hash`, отзывает сессии и
пишет audit-событие без данных учётной записи; блокировка, роль, профиль и права
не меняются. Заблокированная учётная запись остаётся заблокированной. Reset себя
возвращает `409 self_reset_forbidden`.

Уточнение MVP2-25 по ревью: варианты `/admin/lookups` сохраняют `id/name/type` и
дополнительно возвращают nullable `context` (кафедра, программа/курс или родительское
подразделение из существующих справочников). UI всегда показывает уникальный ID.
Деталь пользователя дополнена `available_permission_codes`: серверный перечень
допустимых кодов для текущего подразделения staff (для прочих ролей пустой).
Он обновляется при переводе; сервер по-прежнему проверяет код и scope каждого grant.
### Посещаемость MVP2-05 (#70)

- `GET /api/v1/attendance`: только студент, свои текущие занятия по предикату
  участников расписания и собственные сохранённые исторические отметки. Фильтры:
  `lesson_id`, `limit` (1–100, по умолчанию 20), `cursor`; порядок `lesson_id ASC`,
  стандартная keyset-пагинация `Page`. Чужие student/group-фильтры запрещены.
- `GET /api/v1/attendance/lessons/{lesson_id}`: та же проверка доступа; чужое
  занятие без собственной сохранённой отметки — `404 not_found`.
- `PUT /api/v1/attendance/lessons/{lesson_id}/students/{student_id}`:
  `{status: "attended" | "absent"}`, создание или изменение одной отметки.
- `DELETE` по тому же пути снимает отметку. Отсутствующая строка — no-op
  после проверки прав, участников и допустимости операции.

Ответ write/detail: `lesson_id`, `student_id` (строковые BIGINT), `status`
(`attended|absent|unmarked`), `lesson_status`, `starts_at`, `ends_at`, `updated_at`
(NULL для unmarked). Состав группы и ссылки на другие позиции переноса не выдаются.
PUT/DELETE возвращают `200`; `401` без действующей сессии, `403` для роли/permission,
`404` вне scope, `409 invalid_transition` для недопустимого состояния/времени,
`422` для неверных ID/тела. OpenAPI — фактические схемы и ошибки.

Преподаватель: актуальное `teaching_assignments` для проведения и текущей группы
студента плюс фактическое участие с учётом подгруппы; `lessons.teacher_id` не даёт
права. Деканат: эффективное `attendance.edit`; после перевода или отмены/переноса
доступна только корректировка/очистка существующей записи. Новые отметки — только
текущим участникам на `scheduled` с момента `starts_at`. Перенос не копирует отметки.

Операция и аудит атомарны; блокировки занятия, студента и назначения упорядочивают
конкурентные изменения. Последнее успешно сохранённое изменение побеждает.
Повтор того же статуса не меняет автора/время и не создаёт аудит. Уведомления,
баллы, публичное чтение аудита и UI журнала в эти операции не входят.

Уточнение F-01/F-03: write-scope существующей отметки дополнительно проверяет
сохранённые исходные группу/подгруппу и номер периода принадлежности. Эти служебные
поля неизменяемы через API. Повторный перевод не возвращает преподавателю доступ
к старой отметке. Создание до `students.membership_changed_at` запрещено (`404`),
включая общее занятие и повторное создание после DELETE. Начальная граница —
миграция `20261115_05` либо создание профиля; до неё новые отметки не создаются.
У legacy-записей с неизвестным происхождением PUT/DELETE разрешены только деканату.
GET определяет актуальные группу и подгруппу в SQL того же запроса, не из ранее
загруженного ORM-объекта; собственные сохранённые отметки остаются доступными.
Публичные схемы и формат аудита не изменились.

## Официальный staff schedule editor (MVP2-12, #74)

Все маршруты `/api/v1/staff/schedule` требуют актуальную активную staff-роль
деканата и эффективное глобальное `schedule.edit`. Admin/teacher/student без этого
доступа получают 403; проверка выполняется по БД при каждом запросе, включая старый
JWT после отзыва разрешения. Student `/schedule` сохраняет собственный scope.

- `GET /catalog/{kind}`: `groups`, `subgroups`, `teachers`, `rooms`,
  `course-offerings`, `teaching-assignments`. Параметры `q`, `after_id`, `limit`
  (1–100); `group_id` для подгрупп/проведений/назначений,
  `course_offering_id` для групп/назначений. Неуместные фильтры отклоняются.
  Возвращает `items`, `next_after_id`; справочники содержат безопасные названия,
  ссылки на корпус/семестр, группы проведения и предметные назначения преподавателя.
- `GET /lessons?resource=group|teacher|room&resource_id=...&date_from=...&date_to=...`:
  1–31 календарных дней Europe/Moscow, `limit` 1–200, `after_id`;
  порядок `(starts_at, id)`. Формат `after_id`/`next_after_id` сохраняется:
  ID последней выданной пары служит опорой `(starts_at, id)` в той же выборке.
  Если опора удалена или больше не попадает под фильтры, возвращается 422;
  клиент обновляет страницу с начала. Между страницами нет snapshot-изоляции.
  Участники, аудитории и продолжения загружаются пакетно для всей страницы;
  только официальные занятия, включая сохранённые cancelled/moved.
- `GET /lessons/{id}`: полное редактируемое состояние, participants
  (`group_id`, nullable `subgroup_id`), room_ids, version, status, previous/next ID
  и ID создателя. Дополнительно `display` возвращает подписи связанных объектов.
  То же поле включено в элементы `GET /lessons` и ответы `POST /lessons`,
  `PATCH /lessons/{id}`, `/move`, `/cancel`, `/restore`. Историческое чтение не
  требует текущих teaching_assignments.
- `POST /lessons`: создание scheduled, 201; полный `LessonWrite`.
- `PATCH /lessons/{id}`: полный предполагаемый `LessonWrite` плюс ожидаемая `version`.
- `POST /lessons/{id}/cancel`, `/restore`: тело только `{version}`.
- `POST /lessons/{id}/move`: полный новый `LessonWrite` плюс версия исходного,
  201 с новым занятием; исходное сохраняется moved. Новая запись version=1.

`LessonWrite`: course_offering_id, nullable teacher_id, starts_at/ends_at с часовым
поясом, kind (lecture/seminar/lab/other), непустые participants, room_ids.
Клиент не задаёт статус, автора, previous_lesson_id или is_additional. ID — строки
положительных PostgreSQL bigint. Физический DELETE отсутствует.

`EditorLesson.display` не заменяет существующие ID-поля. `course_offering` содержит
`id`, `discipline_id`, `discipline_name`, nullable `discipline_code`, `term_id`,
`term_name`, `term_starts_on`, `term_ends_on`, `attestation_type` и `groups` — список
связанных `{id, name}` из `course_groups`; ID проведения остаётся идентификатором,
который различает записи даже при полном совпадении остальных характеристик.
`teacher` — nullable `{id, full_name}`; при наличии аккаунта `full_name` берётся из
`users.full_name`, иначе из `teachers.full_name`;
`participants` — по одной записи на существующего участника с `group_id`,
`group_name`, nullable `subgroup_id` и `subgroup_name`; `rooms` — по одной записи на
аудиторию с `id`, `name`, `building_id`, `building_name`. Поэтому одинаковые
названия не объединяют разные сущности. Подписи загружаются пакетно для страницы
расписания; catalog lookup не требуется.

Обычное редактирование разрешено только scheduled; cancel: scheduled→cancelled,
move: scheduled→moved + новая scheduled, restore: cancelled→scheduled.
Старая moved не активируется, перенос продолжается от последней scheduled.
Перенос обязан изменять starts_at или ends_at; сохранение прежнего слота,
включая изменение только преподавателя/аудиторий, отклоняется 409 invalid_transition
до записи. Для изменения атрибутов в прежнем слоте используется PATCH.
Проверяется выбранное предметное назначение преподавателя, а не назначение
сотрудника; новое назначение требует teaching_assignments для всех групп.

Изменение повышает version ровно один раз; no-op — ноль, без аудита. Устаревшая
версия: 409 version_conflict; запрещённое состояние: invalid_transition;
последняя группа с привязанной работой: assessment_group_in_use;
блокировка/сериализация: concurrent_change; нарушение SQL-связей: assignment_conflict.
Конфликт движка #73: 409 schedule_conflict, типизированные error.details с кодами
teacher_conflict/room_conflict/participants_conflict. Нет гарантии резервирования
ресурсов между одновременными созданиями разных занятий (граница #73).

При cancel/move флаги связанных assessment_groups и аудит меняются атомарно;
дата, связь, результаты и посещаемость сохраняются. Подтверждение даты у
cancelled/moved запрещено PostgreSQL-проверкой; teacher API принадлежит #71.
После commit предусмотрена точка подключения доменного события #86, рассылки нет.
Точные схемы: `backend/openapi.json` → generated TS.


## Поиск студентов и академический статус MVP2-27

| Метод | Путь | Доступ | Вход / ответ |
|---|---|---|---|
| GET | `/staff/students` | `students.read` | `q`, `faculty_id`, `program_id`, `course_number`, `limit`, `cursor` → страница студентов |
| GET | `/staff/students/filters` | `students.read` | справочники факультетов, программ и курсов |
| GET | `/staff/students/{student_id}` | `students.read` | минимальный профиль студента |
| GET | `/staff/students/{student_id}/academic-status` | `students.status.edit` | узкое status-only исключение: только ID и текущий статус, без профиля/поиска |
| GET | `/staff/students/status-operations/{operation_id}` | `students.status.edit` | `student_id`, `academic_status`, `reason` → receipt с `completed` и сохранённым результатом |
| PATCH | `/staff/students/{student_id}/academic-status` | `students.status.edit` | `{ academic_status, reason, operation_id }` → сохранённый статус и результат операции |

Поиск по `q` ищет подстроку в ФИО или текущей группе. Результат содержит ID,
ФИО, группу, курс, программу, факультет и академический статус; запросы к страницам
исполняются на сервере с размером по умолчанию 20 и максимумом 100. Порядок ФИО
использует общий ключ `get_student_name_key` (`Е < Ё < Ж`) и ID для устойчивого
keyset-cursor. Учебный доступ сотрудника деканата действует на все факультеты.

`students.read` и `students.status.edit` независимы. Сотрудник с одним правом
изменения может установить статус для известного ID, но получает только поле
статуса и не может выполнять поиск/чтение профиля. Доступ пересчитывается сервером
на каждом запросе. Допустимы `enrolled`, `academic_leave`, `expelled`, `graduated`;
переходы и исправления не ограничены. Причина аудита — `administrative_change` или
`correction`. Статус блокируется `FOR UPDATE`, before-status читается после получения
блокировки; последнее успешно сохранённое изменение побеждает. No-op не создаёт
аудит. Статус и `student/set_academic_status` в `audit_events` (только при изменении)
и квитанция `student_status_operations` (включая no-op) фиксируются одной транзакцией.
Повтор UUID с тем же actor/student/status/reason возвращает сохранённый исходный ответ;
иной payload с тем же UUID даёт 409 `operation_id_conflict`. Изменение не переключает
`users.is_active` и не меняет другие данные. UI перед отправкой требует подтверждения
оформленного внешнего основания. При неопределённом результате запись автоматически не
повторяется. Сотрудник с `students.read` отдельно перечитывает карточку для актуального состояния.

Для staff-поиска `%`, `_` и `\` в `q` — буквальные символы (явный SQL ESCAPE),
кириллица ищется без учёта регистра, включая `Ё/ё`. Курсор привязан к нормализованным
q/faculty_id/program_id/course_number и версии/направлению общей сортировки.
Чужой курсор — 422 `invalid_cursor`; курсоры других разделов не меняются.

Статус изменяется исключительно PATCH (PUT отсутствует). UI требует явного выбора
целевого статуса и подтверждения основания, показывает идентификатор и выбранный
статус; ФИО, группа и прежний статус доступны только при students.read.
Ожидание PATCH ограничено 15 секундами только в этом сценарии. Потеря ответа,
таймаут, неразбираемый ответ или 5xx означают неопределённый результат, а не обещание
rollback. Повторной записи автоматически нет. С правом чтения доступна явная GET-сверка;
status-only сотрудник сверяет UUID квитанцией или проверяет результат внешне. Узкий GET
`/academic-status` требует актуальное `students.status.edit` на каждом запросе и возвращает
только ID и статус. Это одобренное исключение к запрету profile-read для status-only;
оно не даёт общего поиска или карточки. Сверка не отменяет ещё выполняющийся запрос
и не доказывает его исход. Новая запись требует нового осознанного подтверждения.
Модель PostgreSQL row-level lock / last-successful-write-wins не меняется.

UI-карточка `/staff/students/:id` использует существующий GET и переживает обновление
страницы. Параметры поиска и стек границ страниц сохранены в URL; Back/Forward
и явная предыдущая страница не смешивают наборы разных фильтров.

### Учебные объявления преподавателей (MVP2-24)

- `POST /api/v1/teaching/courses/{course_offering_id}/announcements` сразу
  публикует объявление и возвращает `201 Announcement`. Тело принимает
  обязательные `group_id: string | null`, `title` и `body`, а также
  `is_important: boolean` (по умолчанию `false`). Необязательный заголовок
  `Idempotency-Key` принимает UUID. Повтор с тем же ключом и теми же
  параметрами, включая проведение, возвращает `201` с исходной записью после
  проверки текущих прав. Для изменённых параметров применяется
  `409 idempotency_conflict`. Форма прекращает ожидание POST через 15 секунд
  и сохраняет ключ для повтора при сетевом сбое или тайм-ауте.
- `GET /api/v1/teaching/courses/{course_offering_id}/groups/{group_id}/announcements`
  возвращает преподавателю общие объявления и объявления выбранной группы.
  Заголовок ответа `X-Can-Publish-To-All-Groups` показывает, покрывают ли
  текущие назначения все группы, а `X-Announcement-Teacher-Id` содержит
  идентификатор самого преподавателя.
- `GET /api/v1/academics/courses/{course_offering_id}/announcements`
  возвращает студенту общие объявления и объявления его текущей группы.
  Сервер определяет группу по аутентифицированному аккаунту и сообщает её в
  `X-Announcement-Group-Id`. Клиент сравнивает её с группой из актуального
  `/api/v1/users/me` и использует обе проверки перед показом данных.

Списки используют `Page<Announcement>`, `limit` от 1 до 100 (по умолчанию
20) и непрозрачный `cursor` для порядка `created_at DESC, id DESC`.
`Announcement` содержит `id`, `course_offering_id`, `group_id`,
`teacher: {id, full_name}`, `title`, `body`, `excerpt`, `is_important`,
`created_at`. ID передаются строками положительного BIGINT. Сервер берёт
ФИО из аккаунта или, если аккаунт не привязан, из профиля преподавателя.
Фрагмент строится из текста со свёрнутыми пробельными символами и
ограничивается 160 символами. Полный текст сохраняет переносы и отображается
как обычный текст. Заголовок после удаления пробелов по краям содержит
1–200 Unicode-символов, непустой текст — 1–20 000. Сервер определяет автора
и время. Лишние и дублирующиеся параметры отклоняются.

Действующая Bearer-сессия обязательна (`401`). Неподходящая роль или
отсутствие необходимого назначения при публикации возвращает `403`.
Чтение чужого проведения или группы возвращает `404`. Ошибки формата,
чужой или некорректный курсор возвращают `422`.
Группа вне проведения даёт `422` преподавателю с назначениями на все группы.
При отсутствии назначений или при обращении к неназначенной группе в частично
доступном проведении сервер возвращает одинаковый `403` для любой пары ID.
Общая публикация без полного набора назначений возвращает `403`, в том числе
при отсутствии групп. Все ответы с содержимым ленты
используют `Cache-Control: no-store`.


**Известное ограничение R-03 — повтор после отзыва назначения.**
Идемпотентный ключ не сохраняет право на публикацию. Если первый POST
успешно зафиксировал объявление, но ответ потерялся, а до повтора у
преподавателя отозвали необходимое назначение, повтор с тем же
`Idempotency-Key` вернёт `403` до поиска ранее сохранённой записи.
Объявление и единственное событие аудита при этом уже могут существовать.
Интерфейс считает `403` окончательным отказом и очищает неопределённую
попытку вместе с ключом; после восстановления назначения новая отправка
того же текста с новым ключом может создать дубликат.
Перед повторным созданием следует проверить наличие объявления через
пользователя с актуальным правом чтения. Не предоставлять отозванному
преподавателю доступ к закрытой ленте только ради сверки результата.
Это известное ограничение MVP2-24, а не гарантия восстановления после
отзыва назначения. Ключ попытки хранится только в состоянии открытой
формы и также теряется при её размонтировании или перезагрузке.

## Журнал деканата (MVP2, REQ-G13/G18)

Префикс `/api/v1/staff/journals`. Доступ проверяется по действующим глобальным
grants сотрудника деканата на каждом запросе. `grades.edit` даёт доступ к баллам,
итогам и их истории. `attendance.edit` даёт доступ к посещаемости. Для каталога
и минимального состава группы достаточно любого из двух разрешений.

В таблице `C=/courses/{course_offering_id}`, `J=C/groups/{group_id}`. Все маршруты
возвращают `Page(items,next_cursor)`. По умолчанию `limit=20`, диапазон 1–100.
Студенты сортируются по русскому алфавиту с `student_id` для совпадающих имён.
Курсор применим к исходному пользователю, маршруту и фильтрам.

| GET | Grant | Выборка |
| --- | --- | --- |
| `/catalog` | любой учебный grant журнала | Пары проведения и группы, названия дисциплины, периода и группы. Фильтры `course_offering_id`, `group_id`, `term_id`, поиск `q`. Тип аттестации доступен при `grades.edit`. |
| `J/students` | любой учебный grant журнала | Текущие `student_id`, `full_name`. |
| `J/assessments` | `grades.edit` | Назначенные работы, фильтр `assessment_group_id`. |
| `J/assessments/{assessment_group_id}/results` | `grades.edit` | Текущий состав, сохранённые результаты и подтверждённая история переведённых студентов. Для удалённой оценки бывшего участника `history_only=true`, `result_id=null`, `score=null`, `can_edit=false`. |
| `J/final-results` | `grades.edit` | Текущие студенты выбранной группы, ручные итоги и сведения о пересдаче. |
| `C/historical-final-students` | `grades.edit` | Студенты с подтверждёнными событиями итогов по проведению. `history_only` означает, что итог удалён. |
| `J/lessons` | `attendance.edit` | Занятия выбранной группы, фильтры `lesson_id`, `starts_from`, `starts_before`, `status`. |
| `J/lessons/{lesson_id}/attendance` | `attendance.edit` | Текущие участники и сохранённые отметки с исходной группой. Историческая отметка имеет `is_historical=true`. `can_edit` учитывает возможность исправить сохранённую отметку или создать текущую. |
| `J/assessments/{assessment_group_id}/results/{student_id}/history` | `grades.edit` | История по паре `(assessment_group_id, student_id)`. |
| `C/students/{student_id}/final-result/history` | `grades.edit` | История по паре `(course_offering_id, student_id)`. |

Списки студентов, результатов, итогов и отметок принимают `student_id` и поиск
`q` по имени. В историческом списке итогов принадлежность к группе не
устанавливается. Сохранённый исторический итог читается через существующий
`GET /api/v1/final-results/courses/{course_offering_id}/students/{student_id}`.

События отсортированы от новых к старым по `(created_at,id)`. Каждый элемент
содержит `event_id`, `action`, `created_at`, `actor_user_id`, доступное текущее
имя автора `actor_name` и типизированные `before` и `after`. Для баллов снимок
содержит `score`. Для итогов доступны `grade_value`, `passed`, `retake_date`
и `retake_location`. У создания `before=null`, у удаления `after=null`.
История сохраняется после удаления и повторного создания результата.

Запись выполняется существующими индивидуальными операциями оценок,
посещаемости и итогов. При невозможности подтвердить ответ на запись клиент
перечитывает конкретную запись.
