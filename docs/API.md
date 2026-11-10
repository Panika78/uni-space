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
| POST | `/auth/logout` | Refresh cookie, необязательный Bearer fallback, без тела | `204`, cookie удалена; отзыв только при найденном пригодном идентификаторе |
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
  code: "study_certificate";
  title: string;
};

type CreateApplicationRequest = {
  service_code: "study_certificate";
  form_data: {
    place_of_submission: string;
  };
};

type Application = {
  id: Id;
  service: Service;
  form_data: { place_of_submission: string };
  review_status:
    | "submitted" | "in_review" | "needs_correction"
    | "resubmitted" | "approved" | "rejected";
  document_status: "not_required" | "pending" | "ready" | "failed";
  feedback: string | null;
  created_at: DateTime;
  updated_at: DateTime;
};
```

В MVP 1 создаётся `submitted/pending`, обработки и скачивания PDF нет. Место предоставления — обязательный обычный текст, 1–300 символов после обрезки крайних пробелов. Повторные самостоятельные заявки разрешены.

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

## 6. Авторизация и клиентское поведение

- Refresh cookie: `uni_space_refresh`, `HttpOnly`, `Secure` в production, `SameSite=Lax`, `Path=/api/v1/auth`, без `Domain`.
- Login, refresh и logout ограничивают тело 16384 байтами до разбора JSON, включая потоковую передачу без `Content-Length`; превышение — `413 request_too_large`. Небольшое непустое тело refresh/logout — `422 validation_error`.
- Auth проверяет `Origin`; ответы с токенами и персональные ответы имеют `Cache-Control: no-store`.
- Успешный login отзывает только существующую сессию, которую идентифицирует текущая refresh-cookie, затем создаёт новую. Неверные credentials старую сессию не отзывают; независимые устройства не затрагиваются.
- Logout сначала ищет сессию по refresh-cookie, включая известную использованную/истёкшую cookie. Найденная сессия имеет приоритет даже при Bearer другой сессии: один запрос не отзывает две независимые сессии.
- Если cookie отсутствует или не идентифицирует сессию, logout может использовать необязательный `Authorization: Bearer <access_jwt>`. JWT проверяется существующим валидатором (подпись/HS256, claims, issuer/audience, exp/iat/nbf, token_type); sid выбирается вместе с проверкой user_id == sub. Истёкший, невалидный Bearer и несовпадение владельца не дают права отзыва.
- `204` означает завершение обработки logout и удаление cookie. При найденной сессии отзыв атомарно фиксируется под `SELECT ... FOR UPDATE`; при отсутствии пригодных идентификаторов `204` остаётся идемпотентным без отзыва. Уже отозванная сессия обрабатывается идемпотентно. Поэтому сам `204` не доказывает фактический отзыв активной серверной сессии. Access не обязателен: cookie-only клиент совместим.
- Frontend до очистки сохраняет доступный access только во временной переменной и отправляет его на фиксированный внутренний logout с `redirect: 'error'`. Устаревшее поколение не отправляет logout новой авторизации. После `204` сообщение нейтральное: «Вы вышли из приложения»; при сетевой ошибке отображается обычная форма входа с кратким сообщением. Последующий успешный login отзывает текущую cookie-сессию перед созданием новой.
- Access хранится только в памяти приложения. Сроки access и сессии, проверка JWT, отзыв и ротация определяются ARCHITECTURE.md и DB.md.
- Refresh координируется между вкладками и не повторяется автоматически после сетевой ошибки.
- Исходный запрос повторяется один раз только после `401 access_expired` и успешного refresh. Login, refresh и logout автоматически не повторяются.
- При потере ответа создания заявки клиент проверяет список, не отправляет заявку повторно автоматически.
- При logout и смене аккаунта очищается персональный кеш; запоздавшие ответы предыдущей авторизации не применяются.

## 7. Источники подхода

Соглашения адаптированы для uni-space; схемы предметных данных определены проектом.

- [Google AIP-158: Pagination](https://google.aip.dev/158).
- [Microsoft Graph: Error responses](https://learn.microsoft.com/en-us/graph/errors).
- [OpenAPI Specification](https://spec.openapis.org/oas/).
