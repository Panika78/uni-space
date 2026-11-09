# uni-space

Конкурсный прототип университетского кабинета: расписание, успеваемость, заявки, новости и персональные уведомления.

## Текущий статус

Созданы воспроизводимые основы backend и frontend. Backend использует FastAPI,
синхронный SQLAlchemy 2, psycopg 3, Alembic и PostgreSQL; frontend — React,
TypeScript и Vite. Предметные модели и API будут добавляться следующими задачами.
Приоритет — MVP 1, работающий кабинет студента.

## Документация

- [PRD](docs/PRD.md) — требования, границы MVP и критерии приёмки.
- [Архитектура](docs/ARCHITECTURE.md) — стек и целевая структура.
- [Модель данных](docs/DB.md) — сущности, связи и ограничения.
- [API-контракт](docs/API.md) — принятый контракт MVP 1; приоритет над предварительным перечнем API в архитектуре.
- [AGENTS.md](AGENTS.md) — правила работы coding-агентов.

Спецификации задают рабочую основу; вопросы `TBD` остаются неутверждёнными. Issues со статусом `Draft` — черновики задач. Прямое поручение пользователя реализовать конкретную задачу разрешает её выполнение в указанном объёме; окончательная приёмка выполняется отдельно.

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
ниже. Проверки клиента:

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
сгенерированных файлов без их перезаписи.

Чтобы добавить компонент shadcn/ui, используйте CLI из `frontend/`:

```bash
npx shadcn@latest add button
```

Конфигурация `components.json` уже инициализирована, компоненты добавляются по
мере необходимости.

## Требования

- Docker 29.9.2 или совместимый;
- Docker Compose 2.40.3 или совместимый;
- для запуска без Docker: Python 3.12.12 и uv 0.13.5.

В контейнерах зафиксированы Python 3.12.12 и PostgreSQL 17.6. Точные версии
Python-зависимостей записаны в `backend/uv.lock`.

## Локальный запуск

Создайте локальный файл окружения. Значения в примере предназначены только для
разработки:

```bash
cp .env.example .env
```

### Backend и PostgreSQL в Docker Compose

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

Проверить healthcheck с правильным и заведомо неправильным паролем, не удаляя
volume:

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
uv sync --frozen
set -a
source ../.env
set +a
uv run alembic upgrade head
uv run python -c \
  'from sqlalchemy import text; from app.core.database import engine; print(engine.connect().execute(text("SELECT 1")).scalar_one())'
uv run uvicorn app.main:app --reload
```

Для host `DATABASE_URL` пароль с URI-символами должен быть закодирован один раз
при формировании URL; не подставляйте такой пароль в строку вручную. В Compose
пароль передаётся отдельной переменной и кодируется entrypoint через
`URL.create()`.

Проверки backend:

```bash
cd backend
DATABASE_URL=postgresql+psycopg://unused:unused@localhost/unused uv run pytest
uv run ruff check .
uv run ruff format --check .
```

`DATABASE_URL` — обязательная настройка API. Если она отсутствует или
некорректна, процесс завершается с именем проблемной настройки, не выводя её
значение.

## Проверки проекта

Для локальных тестов и проверки миграций используется отдельный PostgreSQL
17.6 в Compose-файле `compose.test.yaml`. Он имеет отдельную базу и тестовые
учётные данные, не читает `.env`, не подключается к рабочему `db` и не хранит
данные в постоянном volume. Порт опубликован только на loopback (`55432`), он
должен быть свободен.

Из корня репозитория поднимите тестовую БД и установите зафиксированные
зависимости:

```bash
docker compose -p uni-space-test -f compose.test.yaml up -d --wait test-db
cd backend
uv sync --frozen
export APP_ENV=test
export DATABASE_URL=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test
```

В `backend/` запустите backend lint/format и тесты:

```bash
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pytest
```

На той же тестовой PostgreSQL проверьте миграции на пустой базе и совпадение
текущих ревизий БД с heads Alembic:

```bash
uv run --frozen alembic upgrade head
uv run --frozen python scripts/check_migrations.py
```

Сейчас каталог Alembic не содержит ревизий, поэтому эти команды проверяют
успешное подключение к чистой PostgreSQL и совпадение пустого графа миграций с
пустым состоянием БД. Когда появятся миграции, те же команды применят их и
потребуют, чтобы база достигла всех текущих heads.

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
перезаписывает их. Для обновления файлов используется отдельная команда
`npm run types:generate`.

После проверки остановите и удалите только эфемерный контейнер тестовой БД:

```bash
cd ..
docker compose -p uni-space-test -f compose.test.yaml down --volumes
```

GitHub Actions выполняет проверки отдельными jobs для pull request в `main` и
push в `main`. В CI используются отдельные временные PostgreSQL и тестовые
учётные данные; secrets и production-конфигурация не используются.
