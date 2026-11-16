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
| GET | `/users/me` | — | `200 StudentProfile` |
| GET | `/schedule` | `date_from`, `date_to` | `200 ScheduleResponse` |
| GET | `/academics` | — | `200 AcademicsResponse` |
| GET | `/services` | — | `200 {items: Service[]}` |
| POST | `/applications` | `CreateApplicationRequest` | `201 Application` |
| GET | `/applications` | `limit`, `cursor` | `200 Page<Application>` |
| GET | `/applications/{id}` | ID | `200 Application` |
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
  created_at: DateTime;
  updated_at: DateTime;
};
```

`study_certificate` сохраняет контракт MVP1: `place_of_submission` обязателен, 1–300 символов после trim. Для выписки входная форма пуста, сохранённый период определяется сервером из текущих периодов, связанных с группой студента через `course_groups` и `course_offerings`; при нуле или нескольких применимых периодах возвращается `409 academic_term_unavailable` или `409 academic_term_ambiguous`. При resubmit период сохраняется прежним.

Академический отпуск принимает основание, даты и пояснение для `other`, но до интеграции защищённой загрузки файлов API отвечает `409 service_unavailable` (или `responsible_unit_unavailable`, если деканат не определён); `submitted` не создаётся. Бухгалтерская справка принимает необязательную цель, ответственное подразделение назначается сервером. Неизвестные поля и клиентские ID/статусы запрещены. Недоступность и требования возвращаются в полях `Service` и доступны для просмотра.

Создание доступных услуг возвращает `201 submitted/pending`, без автоматического одобрения или PDF. Ошибки конфигурации — `409 service_unavailable`, `academic_term_unavailable`, `academic_term_ambiguous`, `responsible_unit_unavailable`; ошибки формы — `422 validation_error`.

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
период от клиента, а проверка сохранённой формы не вычисляет его заново. Для
академического отпуска resubmit также остаётся недоступен, пока услуга закрыта до #75.
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

`approved/rejected` терминальны. `document_status` workflow не изменяет, PDF,
вложения и уведомления не запускает. Автоматическая `study_certificate` остаётся
`submitted/pending` до отдельной реализации #67/#83; ручное одобрение для неё
запрещено. Академический статус студента не меняется при одобрении заявления.
#75 должен включать изменение вложений в ту же версию заявления; #83 сохраняет
отдельную транзакцию генерации и её проверки; #84/#85 используют эти API, текущую
версию и обработку 409, без выбора серверного актора/подразделения клиентом.

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
| PUT `/admin/users/{id}/active` | `{is_active:boolean}`; блокировка отзывает все сессии/refresh, разблокировка требует нового входа |
| PUT `/admin/users/{id}/department` | `{org_unit_id}`; все прежние grants удаляются атомарно |
| PUT / DELETE `/admin/users/{id}/permissions` | `{permission_code,scope_org_unit_id}`; grant/revoke отдельного разрешения, результат — деталь пользователя |

Для teacher имя берётся из выбранной свободной записи; существующие назначения
не меняются. Student создаётся с `academic_status=enrolled`, без подгруппы.
Staff создаётся без разрешений. Роль, логин и пароль существующего аккаунта
через этот API не меняются. Учебные PermissionCode допустимы только у деканата
с NULL scope; `applications.review` / `news.publish` — со scope своего подразделения.

409: `login_exists`, `teacher_unavailable`, `self_block_forbidden`, `last_admin`,
`conflict` (конфликт ограничений). 422: `invalid_profile`,
`invalid_permission_scope`, `validation_error`. No-op не создаёт аудит.
Создание аккаунта/профиля, grants, перевод, отзыв сессий и аудит атомарны.

`initial_password` генерирует сервер (192 случайных бита), хранится только Argon2id.
Он возвращается только в одном успешном POST-ответе, не восстанавливается через GET.
UI не помещает его в query cache/storage/history и удаляет при закрытии/уходе.
При потерянном/неразбираемом ответе или 5xx после отправки POST повтор не выполняется:
проверить список по уникальному логину. Неизвестный пароль нельзя восстановить
до #66. Полученный 401 `access_expired` допускает существующий auth-refresh/replay:
это явный отказ до предметной операции, не потерянный ответ после COMMIT.

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
