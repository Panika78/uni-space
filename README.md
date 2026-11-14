# uni-space

Конкурсный прототип университетского кабинета: расписание, успеваемость, заявки, новости и персональные уведомления.

## Текущий статус

Созданы воспроизводимые основы backend и frontend, общие API-соглашения,
генерация OpenAPI/TypeScript-типов и CI-проверки. Backend использует FastAPI,
синхронный SQLAlchemy 2, psycopg 3, Alembic и PostgreSQL; frontend — React,
TypeScript и Vite. Реализованы модели аккаунтов и университетских справочников,
начальная миграция Alembic и серверная авторизация MVP 1 (login, refresh,
logout, проверка пользователя и сессии). Frontend поддерживает вход, восстановление
сессии, безопасный выход и координацию вкладок. Защищённый кабинет содержит
адаптивный каркас студента с навигацией. `/schedule` — стартовый маршрут после
входа: расписание своей группы на день/неделю, московские даты, преподаватели,
все аудитории и базовые статусы изменений. Реализован read-only профиль `/profile`
и API `GET /api/v1/users/me` с серверными академическими связями. Доступ к кабинету
проверяет `StudentAccess` через этот API, профиль доступен из общего `ProfileContext`.
Каталог услуг `/services` и форма подачи заявления реализуют TASK-013.
TASK-014 добавляет вкладку «Мои заявления», отдельную страницу `/applications/:id`
и защищённые GET списка/деталей с SQL-изоляцией по студенту и cursor-пагинацией.
После отправки доступны детали полученного ID и свежий список; при неизвестном
результате POST можно проверить список без автоматической повторной отправки. Личный центр
уведомлений TASK-016 открывается из bell в StudentLayout, использует серверную
изоляцию и cursor-пагинацию; действия прочтения остаются вне MVP 1.
Успеваемость `/academics` и её API реализуют TASK-012. Остальные разделы
добавляются поэтапно. Приоритет — MVP 1.

## Успеваемость студента (TASK-012)

`/academics` и `GET /api/v1/academics` показывают дисциплины текущей группы
за период по московской дате, персональные суммы и отдельный блок сессии.
Ноль отличается от отсутствия оценки; максимум включает все назначенные работы.
Итог не вычисляется из суммы. Известные сведения о пересдаче находятся под
соответствующим результатом. Нет архива, редактирования и страницы дисциплины.

Миграция `20261112_02` добавляет четыре таблицы оценивания, уникальность назначений,
ограничения шкалы и триггеры целостности связей/видов аттестации. После миграций
повторите штатный `scripts/migrate-postgres.sh`: ACL даёт API только SELECT
для успеваемости и необходимых связей, без записи и sequence usage.
Клиент использует существующие отмену запросов и очистку кеша при смене сессии.

Миграция `20261112_03` запрещает смену группы/работы назначения с результатами
и уменьшение максимума ниже записанных баллов, в том числе при конкурентных SQL.
`max_score_locked` не добавлен. Если старые данные уже содержат превышение максимума,
миграция отклоняется без изменения оценок: исправление требует сверки с исходными
учебными данными. Ранее ошибочное переназначение автоматически не восстанавливается:
текущая группа студента не является историей его принадлежности.
Браузерные фикстуры создают активный семестр по московской дате;
фиксированные даты сценариев расписания сохранены.

PostgreSQL-проверки включены в `pytest -m integration`, UI и смена аккаунта — в
`npm test`. Для браузерной проверки после `deploy/schedule_fixtures.py` выполните
на изолированной БД `PYTHONPATH=backend uv run --locked --python 3.12.16 --project backend python deploy/academics_fixtures.py`,
запустите API/Vite и `SCHEDULE_TEST_PASSWORD=fictional-schedule-password node frontend/e2e/academics.browser.mjs`.

Цепочка Alembic: `20261111_02 → 20261112_01` (уведомления из main)
`→ 20261112_02` (академические таблицы) `→ 20261112_03` (защита результатов).
Используйте штатный upgrade существующей БД со схемой main; `alembic stamp`
не применяется. Экспериментальные БД старой, ещё не объединённой версии PR #47
имеют конфликтующие ID ревизий и требуют отдельной сверки схемы/истории перед
переносом данных; автоматически переименовывать их ревизии нельзя.

## Расписание студента (TASK-010, TASK-011)

`GET /api/v1/schedule?date_from=2026-11-09&date_to=2026-11-15` требует существующий
Bearer и профиль студента. Обе даты обязательны, допускается 1–31 календарный день
включительно. Неизвестные параметры (в том числе `student_id`/`group_id`) дают 422.
Сервер выбирает занятия по `students.group_id` и фактическим `lesson_groups`,
сортирует по `starts_at, id`; связанные группы и аудитории не размножают занятия.
Время ответа — UTC; календарь и отображение — `Europe/Moscow`. Занятие через
полночь видно на обеих пересекаемых датах, если оно актуально; старые перенесённые
и отменённые позиции показываются только на московской дате начала. Цепочки переносов возвращают
непосредственного предшественника и последнюю позицию за пределами диапазона;
позиции без назначения текущей группе не раскрываются.

Отменённые и старые перенесённые позиции показываются компактными строками,
актуальные — полноценными карточками. Старые позиции используют `latest_lesson`;
отмена конечной позиции указана явно. Кнопка «Показать конечную позицию» выбирает
московскую дату начала, загружает нужную неделю и переводит фокус на запись,
сохраняя режим дня/недели. При недоступной позиции даты и перехода нет.
Временная ошибка загрузки не сбрасывает переход: после успешного повтора фокус
восстанавливается. Если целевая запись исчезла, выводится нейтральное сообщение.

Миграция `20261111_01` добавляет учебные периоды, дисциплины, проведения с
`attestation_type`, корпуса, аудитории и связи занятий. Таблицы аккаунтов,
студентов, преподавателей и групп используются повторно. Подгруппы и серии не
создаются. Для production используйте существующий `scripts/migrate-postgres.sh`:
он повторяет явную настройку ACL после миграций. Новые права — только SELECT
используемых расписанием таблиц; запись в расписание, его последовательности и
неиспользуемые справочники API недоступны. Подробнее — [PRODUCTION.md](docs/PRODUCTION.md).

Браузерный тест `frontend/e2e/schedule.browser.mjs` использует настоящий API,
Vite и отдельную тестовую PostgreSQL, не production-данные. В пустой **изолированной**
БД примените миграции и создайте маленькие вымышленные фикстуры (не демонабор MVP):

```bash
# Из корня; APP_ENV=test, DATABASE_URL и JWT_SIGNING_KEY указывают на тестовый стенд.
printf '%s' 'fictional-schedule-password' | PYTHONPATH=backend uv run --locked --python 3.12.16 --project backend python deploy/schedule_fixtures.py
# Запустите backend :8000 с COOKIE_SECURE=false, ALLOWED_ORIGINS=["http://localhost:5173"]
# и Vite :5173 с обычным proxy :8000. Playwright устанавливается отдельно от приложения.
SCHEDULE_TEST_PASSWORD=fictional-schedule-password node frontend/e2e/schedule.browser.mjs
```

`PLAYWRIGHT_MODULE` задаёт путь к `playwright/index.mjs`, `CHROMIUM_PATH` — необязательный
путь Chromium. Скрипт проверяет desktop 1440 px, 360 px, Los Angeles/Tokyo/UTC,
воскресенье, полночь, клавиатуру, пустые дни, ошибки, login/reload/logout и смену
двух аккаунтов. Он выполняет пять login; повторять полный прогон следует в новом
окне rate limiter. Скриншоты сохраняются в `work/`. CI выполняет этот тест отдельно;
production-интеграция проверяет настоящий API под `uni_space_api` после повторного ACL.

## Каталог услуг и заявления (TASK-013)

Каталог `GET /api/v1/services` и отправка `POST /api/v1/applications` используют
серверную авторизацию студента. Форма справки об обучении сохраняет результат в
PostgreSQL; при неопределённом исходе отправка автоматически не повторяется.
Production API получает только SELECT для каталога и SELECT/INSERT для заявлений
с необходимой sequence usage.

Браузерный сценарий услуг использует отдельную тестовую PostgreSQL и двух
вымышленных студентов. Команды настройки и запуска приведены в разделе «Проверки
проекта» ниже; CI исполняет `frontend/e2e/services.browser.mjs` отдельной job.

После миграций на изолированной тестовой БД создайте фиктивные аккаунты и
запустите backend с `APP_ENV=test`, тестовыми `DATABASE_URL`/`JWT_SIGNING_KEY`,
`COOKIE_SECURE=false` и `ALLOWED_ORIGINS=["http://localhost:5173"]`:

```bash
uv run --locked --python 3.12.16 --project backend python backend/scripts/seed_services_browser_test_students.py > /tmp/services-e2e.env
mkdir -p work/browser-tooling
npm install --prefix work/browser-tooling --no-save --package-lock=false playwright@1.57.0
node work/browser-tooling/node_modules/playwright/cli.js install chromium
(cd backend && uv run --locked --python 3.12.16 uvicorn app.main:app --host 127.0.0.1 --port 8000)
```

В другом терминале запустите Vite (`cd frontend && npm run dev -- --host
127.0.0.1`), затем выполните browser E2E с seeded credentials:

```bash
set -a
. /tmp/services-e2e.env
set +a
export PLAYWRIGHT_MODULE="$PWD/work/browser-tooling/node_modules/playwright/index.mjs"
export SERVICES_TEST_URL=http://localhost:5173
node frontend/e2e/services.browser.mjs
node frontend/e2e/applications.browser.mjs
node frontend/e2e/applications-review.browser.mjs
node frontend/e2e/applications-pagination.browser.mjs
```

Сценарий требует второго тестового студента и проверяет смену аккаунта без
пропуска; GitHub Actions выполняет его отдельной job с одноразовой PostgreSQL,
реальными API/UI процессами и двумя вымышленными аккаунтами.
`applications.browser.mjs` проверяет TASK-014 на desktop и 360 px: создание,
детали, список, повторный вход, «Показать ещё», восстановление прокрутки,
потерянный ответ POST и изоляцию аккаунтов.
`applications-review.browser.mjs` использует управляемые тестовые ответы GET для
проверки обновления всех загруженных страниц, 200 → 404/network error → 200,
мобильных подписей и полного клавиатурного возврата с fallback при исчезновении
исходной записи. Список обновляется при каждом повторном открытии; загруженные
страницы сохраняются в персональном кеше, а контекст возврата привязан к исходной
записи и записи истории браузера.
`applications-pagination.browser.mjs` проверяет запрет продолжения по старому
курсору после ошибки refresh, полный повтор обновления и независимый повтор
неудачной загрузки следующей страницы, включая клавиатуру и прокрутку на обеих ширинах.

## Документация

- [PRD](docs/PRD.md) — требования, границы MVP и критерии приёмки.
- [UX/UI-спецификация](docs/UI_UX_SPEC.md) — согласованный интерфейс и адаптивное поведение.
- [Архитектура](docs/ARCHITECTURE.md) — стек и целевая структура.
- [Модель данных](docs/DB.md) — сущности, связи и ограничения.
- [API-контракт](docs/API.md) — принятый контракт MVP 1; приоритет над предварительным перечнем API в архитектуре.
- [Серверная авторизация](docs/AUTH.md) — настройки, Origin, транзакции, rate limiting и ограничения TASK-006.
- [Production-конфигурация](docs/PRODUCTION.md) — отдельный Compose, TLS, секреты, обновление и backup/restore (TASK-019).
- [AGENTS.md](AGENTS.md) — правила работы coding-агентов.

Основные спецификации приняты; явно помеченные `TBD` и предварительные решения требуют отдельного согласования. Issues со статусом `Draft` — черновики задач. Прямое поручение пользователя реализовать конкретную задачу разрешает её выполнение в указанном объёме; окончательная приёмка выполняется отдельно.

## Frontend

Требуется Node.js 24.22.1 (см. `frontend/.nvmrc`) и npm 11.19.1. Установите
точные зависимости из lock-файла и запустите Vite:

```bash
cd frontend
npm ci
npm run dev
```

Vite доступен по адресу <http://localhost:5173>. Запросы `/api/*` направляются
на `http://localhost:8000`; перед проверкой API запустите backend по инструкциям
ниже. Для входа открывайте именно `http://localhost:5173`: сервер требует точный
Origin из `ALLOWED_ORIGINS`, а для локального HTTP — `COOKIE_SECURE=false`.
Нужен современный браузер с Web Locks и доступным localStorage; подробнее о
координации, ограничениях и браузерном прогоне — [AUTH.md](docs/AUTH.md#браузерный-жизненный-цикл-task-007). Проверки клиента:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run types:check
```

Общие TypeScript-типы создаются из схем backend в OpenAPI. После изменения
Pydantic-моделей обновите снимок OpenAPI и типы командой `npm run types:generate`
из `frontend/`. Команда `npm run types:check` проверяет актуальность обоих
сгенерированных файлов без их перезаписи. Обе команды запускают Python 3.12.16
через `uv run --locked --python 3.12.16`, поэтому не переписывают
`backend/uv.lock`. Если lock устарел, обновите его явной командой `uv lock`.

Чтобы добавить компонент shadcn/ui, используйте CLI из `frontend/`:

```bash
npx shadcn@latest add button
```

Конфигурация `components.json` уже инициализирована, компоненты добавляются по
мере необходимости.

## Требования

- Docker 29.9.2 или совместимый;
- Docker Compose 2.40.3 или совместимый;
- для запуска без Docker: Python 3.12.16 и uv 0.13.7.

В контейнерах зафиксированы Python 3.12.16, PostgreSQL 17.11 и Nginx 1.30.6
с manifest digests. Обоснование security updates и источники — в
[PRODUCTION.md](docs/PRODUCTION.md#базовые-образы-и-security-updates-sec-01-pr-31). Точные версии
Python-зависимостей записаны в `backend/uv.lock`.

## Production-конфигурация

Подготовлен отдельный `compose.prod.yaml`: Nginx с HTTPS отдаёт сборку SPA и
проксирует API; FastAPI и PostgreSQL доступны только во внутренних сетях.
Используются существующий launcher `--production`, внешние файлы секретов,
постоянный volume и readiness по HTTP/БД/Alembic. TASK-022 разделяет администратора,
владельца миграций и ограниченную роль API; их пароли и mounts раздельны.
Dev Compose остаётся отдельным.

Полные инструкции запуска, диагностики, обновления/отката, backup и отдельного
восстановления — в [PRODUCTION.md](docs/PRODUCTION.md). Из корня проекта:

```bash
export PROD_ENV_FILE=/absolute/private/path/production.env
bash scripts/production-compose.sh build
bash scripts/production-compose.sh up -d --wait db
bash scripts/migrate-postgres.sh
bash scripts/production-compose.sh up -d --wait --wait-timeout 120
```

Сначала создайте внешний env-файл по `deploy/production.env.example`, случайные
секреты и TLS-файлы по инструкции. Единственный публичный адрес задаётся через
`PUBLIC_ORIGIN=https://<hostname>` (нестандартный порт указывается явно); Compose
согласует его с API Origin и Nginx Host. Недоверенный Host и широкие доверенные
proxy-сети отклоняются. Проверочный стенд с тестовым сертификатом:

```bash
docker build -f backend/Dockerfile -t uni-space-api:task019 .
docker build -f deploy/Dockerfile.web -t uni-space-web:task019 .
# Сначала установите Playwright/Chromium по docs/PRODUCTION.md.
uv run --locked --python 3.12.16 --project backend python deploy/test_production.py
```

Он использует уникальный тестовый project/volume, проверяет реальный HTTPS
с hostname/SNI `uni.test`, отказ на чужом/просроченном сертификате и Host,
SPA/API и реальный браузерный переход `/schedule` → `/login` с загрузкой JS/CSS,
auth/Origin/cookie, proxy/IP spoofing, отказы небезопасного запуска и
backup/restore в отдельную БД; затем удаляет только свои тестовые данные.
Публичное развёртывание, реальный домен/TLS, доступность из России и фактическое
расписание backup остаются в TASK-020. Локальный прогон их не подтверждает.

## Локальный запуск

Создайте локальный файл окружения. Значения в примере предназначены только для
разработки:

```bash
cp .env.example .env
```

### Backend и PostgreSQL в Docker Compose

Этот Compose-файл предназначен для локальной разработки; API опубликован на
`127.0.0.1:8000`. По умолчанию используется `APP_ENV=development`, но явный
`APP_ENV=production` передаётся приложению и включает production-валидацию.
Файл не предоставляет TLS, reverse proxy и другие средства публичного
production-развёртывания. Для публичного запуска API предусмотрена явная команда
`python -m app.core.server --production`: она принудительно включает production-
валидацию до запуска Uvicorn, даже при development в окружении или `.env`.
Границы гарантии SEC-03 и обязательные действия — в [AUTH.md](docs/AUTH.md#режим-запуска-production-sec-03).
Сервер запускается через `app.core.server`: forwarded-
заголовки по умолчанию отключены, доверенный proxy включается только явно через
`PROXY_HEADERS_ENABLED` и `TRUSTED_PROXY_IPS`. Это не заменяет настройку proxy и
сетевую изоляцию backend; обязательные действия описаны в [AUTH.md](docs/AUTH.md).

Поднимите PostgreSQL, примените миграции и запустите API:

```bash
docker compose up -d db
docker compose build api
docker compose run --rm api alembic upgrade head
docker compose up -d api
```

Внутри Compose API подключается к PostgreSQL по адресу `db:5432`.
API получает компоненты подключения отдельно и собирает `DATABASE_URL` через
SQLAlchemy `URL.create()`, поэтому специальные символы в `POSTGRES_PASSWORD`
не требуют ручной подстановки или двойного URL-кодирования.

`POSTGRES_PASSWORD` используется образом PostgreSQL только при первой
инициализации пустого volume. Изменение значения в `.env` не меняет пароль уже
существующей роли в сохранённой БД. Сначала обновите пароль роли в PostgreSQL
или продолжайте использовать прежнее значение; иначе healthcheck пометит БД как
`unhealthy`, а сервис `api` не запустится через `depends_on`.

Swagger доступен по адресу <http://localhost:8000/api/docs>, OpenAPI — по
<http://localhost:8000/api/openapi.json>.

Проверить соединение с PostgreSQL через SQLAlchemy можно так:

```bash
docker compose run --rm api python -c \
  'from sqlalchemy import text; from app.core.database import engine; print(engine.connect().execute(text("SELECT 1")).scalar_one())'
```

## Управление окружением

Подготовка демонстрационных данных MVP 1 выполняется только явной отдельной
командой после миграций; смотрите [DEMO_DATA.md](docs/DEMO_DATA.md) для локального
и production-запуска, дат учебного периода и безопасного повтора. Seed не запускается
миграциями/API, не входит в тестовые фикстуры и не меняет пользовательские заявки.

Посмотреть состояние и логи:

```bash
docker compose ps
docker compose logs -f api db
```

Применить миграции повторно или посмотреть текущие heads:

```bash
docker compose run --rm api alembic upgrade head
docker compose run --rm api alembic heads
```

Проверить healthcheck с правильным и заведомо неправильным паролем в отдельном
Compose-проекте:

```bash
bash backend/tests/test_compose_db_healthcheck.sh
```

Остановить контейнеры, сохранив данные PostgreSQL:

```bash
docker compose down
```

Безвозвратно удалить локальные контейнеры и volume с данными:

```bash
docker compose down --volumes
```

Последняя команда удаляет все локальные данные PostgreSQL этого Compose-проекта.

### Backend на хосте, PostgreSQL в Docker Compose

Compose публикует PostgreSQL только на `127.0.0.1:5432`. Поднимите БД, установите
зафиксированные зависимости и загрузите переменные из `.env`:

```bash
docker compose up -d db
cd backend
uv python install 3.12.16
uv sync --locked
set -a
source ../.env
set +a
uv run --locked --python 3.12.16 alembic upgrade head
uv run --locked --python 3.12.16 python -c \
  'from sqlalchemy import text; from app.core.database import engine; print(engine.connect().execute(text("SELECT 1")).scalar_one())'
uv run --locked --python 3.12.16 python -m app.core.server --reload
```

Для host `DATABASE_URL` пароль с URI-символами должен быть закодирован один раз
при формировании URL; не подставляйте такой пароль в строку вручную. В Compose
пароль передаётся отдельной переменной и кодируется entrypoint через
`URL.create()`.

Проверки backend:

```bash
cd backend
DATABASE_URL=postgresql+psycopg://unused:unused@localhost/unused uv run --locked --python 3.12.16 pytest
uv run --locked --python 3.12.16 ruff check .
uv run --locked --python 3.12.16 ruff format --check .
```

`DATABASE_URL` и `JWT_SIGNING_KEY` — обязательные настройки API. Если настройка отсутствует или некорректна,
процесс завершается с её именем, не выводя значение.

## Проверки проекта

Для локальных тестов и проверки миграций используется отдельный PostgreSQL
17.11 в Compose-файле `compose.test.yaml`. Он имеет отдельную базу и тестовые
учётные данные, не читает `.env`, не подключается к рабочему `db` и не хранит
данные в постоянном volume. Порт опубликован только на loopback (`55432`), он
должен быть свободен.

Каждый раз перед проверкой миграций удаляйте только выделенный тестовый Compose
project со всеми его данными, затем создавайте новый контейнер PostgreSQL. Это
обеспечивает пустую БД и при первом, и при повторном запуске:

```bash
docker compose -p uni-space-test -f compose.test.yaml down --volumes --remove-orphans
docker compose -p uni-space-test -f compose.test.yaml up -d --wait test-db
cd backend
uv python install 3.12.16
uv sync --locked
export APP_ENV=test
export JWT_SIGNING_KEY=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ
export DATABASE_URL=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test
uv run --locked --python 3.12.16 python -c \
  'import sys; print(sys.version); assert sys.version_info[:3] == (3, 12, 16)'
```

В `backend/` запустите backend lint/format и тесты:

```bash
uv lock --check
uv run --locked --python 3.12.16 ruff check .
uv run --locked --python 3.12.16 ruff format --check .
uv run --locked --python 3.12.16 pytest -m "not integration"
uv run --locked --python 3.12.16 pytest -m integration
```

На той же тестовой PostgreSQL проверьте миграции на пустой базе и совпадение
текущих ревизий БД с heads Alembic:

```bash
uv run --locked --python 3.12.16 alembic upgrade head
uv run --locked --python 3.12.16 python scripts/check_migrations.py
```

Миграции TASK-005 создают модели аккаунтов, сессий и университетских справочников.
Проверяйте также `uv run --locked --python 3.12.16 alembic check` для совпадения
ORM и схемы PostgreSQL.

В `frontend/` установите зависимости по lock-файлу и выполните frontend-проверки:

```bash
cd ../frontend
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run types:check
```

`types:check` только сравнивает актуальную генерацию OpenAPI и TypeScript-типы с
закоммиченными файлами и завершается с ошибкой при расхождении; он не
перезаписывает их. Обе команды используют `uv run --locked` и не меняют
`backend/uv.lock`. Для явного обновления файлов используется отдельная команда
`npm run types:generate`. Unit-тесты запускаются без PostgreSQL по умолчанию;
job CI дополнительно запускает отмеченные `integration`-тесты на тестовой БД.

После проверки остановите и удалите только эфемерный контейнер тестовой БД:

```bash
cd ..
docker compose -p uni-space-test -f compose.test.yaml down --volumes --remove-orphans
```

GitHub Actions выполняет проверки отдельными jobs для pull request в `main` и
push в `main`. В CI используются отдельные временные PostgreSQL и тестовые
учётные данные; secrets и production-конфигурация не используются.

## Сквозная приёмка MVP 1 (TASK-018)

[Матрица покрытия и результаты](docs/MVP1_ACCEPTANCE.md) отделяет локальную
приёмку от публикации TASK-020. Существующий `demo-data-browser` CI теперь
выполняет полный путь обоих студентов финального TASK-017 seed на desktop и
360 px, включая настоящий POST, reload, logout/login и прямые проверки изоляции.
Артефакт `mvp1-acceptance` содержит безопасный протокол и скриншоты.
`frontend/e2e/interface.browser.mjs` дополняет его проверкой существующих экранов
на 360, 390, 561, 600, 721, 768, 900, 1440 и 2560 px: оба режима расписания, одна колонка занятий,
переносы/отмены, повторное «Сегодня» с прокруткой, история вкладок услуг, геометрия карточки услуги и ячеек заявлений, профиль, inert и фокус мобильного меню, overlays и reduced motion.
Скриншоты и протокол этой проверки также входят в `mvp1-acceptance`.
Отдельный `access-expiry.browser.mjs` в той же job проверяет настоящий
`401 access_expired`, refresh после reload и единственный replay общего клиента;
для граничного сценария API перезапускается с `ACCESS_TTL_SECONDS=2`.

После независимого ревью TASK-018 обязательный `auth-browser-e2e` запускает
`frontend/e2e/auth.browser.mjs` на собственной PostgreSQL с двумя аккаунтами из
`seed_services_browser_test_students.py`. Vite направляет API на тестовый fault
proxy `http://127.0.0.1:18080`, настоящий backend работает на `:8000`.
`AUTH_TEST_LOGIN_A`, `AUTH_TEST_LOGIN_B`, `AUTH_TEST_PASSWORD` передаются через
окружение; пароли и auth-логи не публикуются в артефактах.
`bash scripts/test-e2e-exit.sh` проверяет, что оба конвейера `node | tee` передают
намеренный exit 37 в CI; workflow явно использует Bash с `pipefail`.
