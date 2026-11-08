# uni-space

Конкурсный прототип университетского кабинета: расписание, успеваемость, заявки, новости и персональные уведомления.

## Текущий статус

Создана воспроизводимая основа backend: FastAPI, синхронный SQLAlchemy 2,
psycopg 3, Alembic и PostgreSQL. Предметные модели и API будут добавляться
следующими задачами. Приоритет — MVP 1, работающий кабинет студента.

## Документация

- [PRD](docs/PRD.md) — требования, границы MVP и критерии приёмки.
- [Архитектура](docs/ARCHITECTURE.md) — стек и целевая структура.
- [Модель данных](docs/DB.md) — сущности, связи и ограничения.
- [API-контракт](docs/API.md) — принятый контракт MVP 1; приоритет над предварительным перечнем API в архитектуре.
- [AGENTS.md](AGENTS.md) — правила работы coding-агентов.

Спецификации задают рабочую основу; вопросы `TBD` остаются неутверждёнными. Issues со статусом `Draft` — черновики задач. Прямое поручение пользователя реализовать конкретную задачу разрешает её выполнение в указанном объёме; окончательная приёмка выполняется отдельно.

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

Поднимите PostgreSQL, примените миграции и запустите API:

```bash
docker compose up -d db
docker compose run --rm api alembic upgrade head
docker compose up -d api
```

Swagger доступен по адресу <http://localhost:8000/api/docs>, OpenAPI — по
<http://localhost:8000/api/openapi.json>.

Проверить соединение с PostgreSQL через SQLAlchemy можно так:

```bash
docker compose exec api python -c \
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

Остановить контейнеры, сохранив данные PostgreSQL:

```bash
docker compose down
```

Безвозвратно удалить локальные контейнеры и volume с данными:

```bash
docker compose down --volumes
```

Последняя команда удаляет все локальные данные PostgreSQL этого Compose-проекта.

## Разработка backend без контейнера API

При уже запущенном PostgreSQL установите зафиксированные зависимости и загрузите
переменные из `.env`:

```bash
cd backend
uv sync --frozen
set -a
source ../.env
set +a
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

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
