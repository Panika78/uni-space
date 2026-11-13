# Локальная приёмка MVP 1 — TASK-018

База сравнения: `1e491143caba39fcf9d587ae22e0cbaf84347ad9` (актуальный main
при начале работы). Все зависимости issue #19 (#5, #8, #10–13, #15–18) закрыты.
Окончательную приёмку выполняет владелец; issue не закрывается этим отчётом.

## Стенд и воспроизведение

Python 3.12.16, Node 24.22.1, Playwright 1.57.0 / Chromium 143.0.7499.4,
PostgreSQL 17.11 из закреплённого `compose.test.yaml`, React/Vite и настоящий
FastAPI. Браузер: 1440×1000 и 360×1000/800, localhost, HTTP только локально.
Пароли генерируются случайно, не выводятся. Seed TASK-017 не изменён.

```bash
docker compose -p task018 -f compose.test.yaml up -d --wait
# APP_ENV=test; DATABASE_URL — только uni_space_test на localhost:55432.
# Для pytest не экспортировать COOKIE_SECURE=false: production unit tests
# проверяют безопасное значение по умолчанию.
(cd backend && uv run --locked --python 3.12.16 pytest -q)
(cd backend && uv run --locked --python 3.12.16 pytest -m integration -q)
(cd frontend && npm ci && npm test && npm run lint && npm run format:check)
(cd frontend && npm run typecheck && npm run build)
```

Браузерный прогон: существующая job `demo-data-browser` в
[ci.yml](../.github/workflows/ci.yml) содержит полную последовательность миграций,
безопасного seed, запуска API/Vite и команды
`node frontend/e2e/demo-data.browser.mjs`. Для локального запуска следовать
[DEMO_DATA.md](DEMO_DATA.md), задав отдельную чистую БД и одноразовые пароли,
`PLAYWRIGHT_MODULE`, `COOKIE_SECURE=false` и точный localhost Origin.
Не запускать pytest и demo seed в одной БД: функциональные фикстуры предполагают
чистую схему. Повторная приёмка начинается с новой выделенной БД.

## Матрица PRD §5 и REQ

`passed` ниже означает фактически выполненную проверку; наличие теста отдельно
не считается успешным результатом. Результаты CI привязаны к SHA PR в GitHub.

| Критерий PRD §5 / REQ | Существующее покрытие | Добавлено TASK-018 | Результат |
|---|---|---|---|
| Публичная ссылка / NF01 | production smoke | — | TASK-020 |
| Вход и выход / A01–A05 | auth integration, auth.browser, authSession.test | Подтверждённый logout и отказ старому Bearer в общем пути | passed (demo E2E + suites ниже) |
| Два аккаунта / NF03, NF06 | test_demo_seed, demo-data.browser | Полный путь обоих на обеих ширинах | passed (demo E2E + suites ниже) |
| Разные профили и академические данные / G01–G03 | auth/academics integration, StudentProfile, AcademicsPage | Прямые HTTP-снимки двух студентов и отсутствие фиктивного долга | passed (demo E2E + suites ниже) |
| Стартовое расписание / S01 | schedule.browser | После каждого login в полном пути | passed (demo E2E + suites ниже) |
| День и неделя / S02 | SchedulePage, schedule.browser | Desktop неделя, мобильный дневной интерфейс | passed (demo E2E + suites ниже) |
| Аудитории, преподаватели, изменения / S03–S04 | schedule integration, test_demo_seed | Цепочки 19→20→23 и 19→21, отмена, сверка новости | passed (demo E2E + suites ниже) |
| Оценки, зачёты, сессия / G01–G03 | academics integration/browser (специальные фикстуры) | Финальный seed, разные текущие баллы, без долга | passed (demo E2E + suites ниже) |
| Создание заявки / D01–D02 | services/application tests, services.browser | Настоящий POST обоих demo студентов | passed (demo E2E + suites ниже) |
| Сохранение и статус / D03, NF07 | applications.browser | ID, поля, submitted/pending, reload, logout/login | passed (demo E2E + suites ниже) |
| Официальные новости / NEW01 | news integration, NewsPages.test, news.browser | Открытие из меню и согласованность дат переноса | passed (demo E2E + suites ниже) |
| Внутренние уведомления / N01 | auth integration, NotificationsDrawer, notifications.browser | Разные уведомления в общем пути | passed (demo E2E + suites ниже) |
| Персональная изоляция / NF04 | auth, schedule, academics, application integration; auth UI tests | Реальный Bearer, отсутствие Bearer, запрет student_id/group_id, одинаковые чужой/отсутствующий 404, no-store | passed (demo E2E + suites ниже) |
| Основные сценарии 360 px / NF02, NF09–NF10 | функциональные browser suites, StudentLayout, StatusStates | Полный путь через меню на 360 и desktop; overflow и screenshots | passed (demo E2E + suites ниже) |
| Обозначение прототипа / NF05 | StudentLayout.test | Переиспользовано | passed (Vitest) |
| Доступность из России / NF08 | — | — | TASK-020 |

## Границы свидетельств

Существующие `auth.browser.mjs`, `authSession.test.ts`, `client.test.ts`,
`StudentSession.test.tsx`, `*.auth.test.tsx` и `*Auth.integration.test.tsx`
покрывают refresh, вкладки, true/false/unknown logout, поздние ответы и очистку
персонального кеша. `applications.browser.mjs` моделирует потерю ответа POST,
проверяет список и отсутствие автоматического дубля; review/pagination browser
покрывают ошибку деталей без старой карточки, конкурентное обновление, клавиатуру
и возврат. Это контролируемые сетевые/UI-сбои, а не доказательство реальных
серверных 5xx. Специальные фикстуры отдельно от финального демонабора проверяют
пустые состояния, результаты сессии, пересдачи и длинный контент.

`news.browser.mjs` требует отдельного набора из 61 новости и пока не включён в CI
(существующий TASK-023); этот самостоятельный browser suite локально НЕ ПРОВЕРЕН.
Его наличие не заменяет фактический прогон. Полный ручной аудит доступности,
production TLS, реальные устройства и доступ из России НЕ ПРОВЕРЕНЫ.

## Результаты запусков

- Backend unit/HTTPX: **328 passed**, 228 integration deselected. Два предупреждения
  устаревшего websockets API. Первый некорректный запуск с COOKIE_SECURE=false дал
  12 ошибок production Settings; после удаления переменной 328 passed без правок продукта.
- Vitest: **21 файл, 254 теста passed** вне sandbox. Исходный запуск в sandbox
  имел ошибку окружения; успешным считается только повторный полный прогон.
- PostgreSQL integration: **228 passed**, 328 unit deselected, 119.69 s.
- Финальный demo E2E: **passed**, оба аккаунта × обе ширины, четыре настоящие
  заявки (ID 1–4) с сохранением после reload/logout/login. Цепочки, новость,
  персональные выборки и 404 проверены реальными HTTP; перехвата API в этом E2E нет.
- Lint, format:check, typecheck, build и Ruff изменённого Python-теста: passed.
- Найден дефект изоляции тестов: demo integration наследовал счётчик login от
  предшествующих тестов и получал 429. Воспроизведение: полный integration suite,
  `test_demo_seed_is_repeatable_and_preserves_user_application`, login → 429.
  Исправление: собственный limiter со штатным лимитом; полный suite повторно passed.
- Добавлен отдельный реальный expiry E2E на том же стенде с разрешённым
  `ACCESS_TTL_SECONDS=2`, после перезапуска API: **passed**. Реальный Bearer
  получает `401 access_expired`; reload выполняет один refresh и восстанавливает
  кабинет; один вызов настроенного API-клиента получает ровно `401 → 200` с одним
  refresh. Это прямой вызов общего клиента в браузере, а не нажатие UI.
- CI первого коммита: [run 43416070563](https://github.com/Panika78/uni-space/actions/runs/43416070563).
  Финальный SHA и окончательные checks фиксируются в описании PR #54.
- Продуктовая логика, API, миграции и demo data не изменялись.

Артефакт CI `mvp1-acceptance` содержит только PASS-протокол с версией браузера и
скриншоты заявок на вымышленные данные; auth headers, пароли, trace/HAR и API-логи
не публикуются. SHA и итоговые checks доступны в PR; публикация PR не означает
публичный deploy или окончательную приёмку.

## Независимое ревью F-01–F-07

Проверен актуальный HEAD PR #54: `38a71439970080c9758515e6abc7c029d7eda8c4`.
F-01 PARTIALLY CONFIRMED: shell не указан, явного pipefail нет; возможность
маскирования зависит от shell runner. F-02–F-07 CONFIRMED по коду workflow/E2E.
Предыдущие сведения о запуске auth browser в CI были неточными: services job
его не вызывала. Старый зелёный CI не подтверждает этот сценарий.

| REQ / замечание | Конкретная проверка / уровень | Ожидается | Факт / статус | Ограничение |
|---|---|---|---|---|
| NF04 / F-01 | scripts/test-e2e-exit.sh; CI regression | Оба реальных pipeline передают exit 37 и создают protocol | passed локально | Отрицательный subprocess намеренно падает; проверяющий процесс обязан завершиться 0 только при exit 37 |
| A01–A05, NF04 / F-02 | auth.browser.mjs; Browser E2E с FastAPI/PostgreSQL и fault proxy | Вкладки, refresh/logout true/false/unknown, потерянные/поздние ответы, независимое устройство | not tested: новый запуск ожидается | Управляемые сбои явно отделены от реальных ответов |
| S01–S04 / F-03 | inspectMoves; Browser E2E + API | 19→20→23, 19→21, отмена, время/аудитории, кнопка конечной позиции и фокус, desktop/360 | not tested: новый запуск ожидается | Финальный seed не меняется |
| NEW01 / F-04 | demo E2E, news detail/back; Browser E2E + API | Заголовок/полный body, даты 21/23, возврат на обеих ширинах | not tested: новый запуск ожидается | news.browser.mjs с 61 новостью — not tested |
| D01–D03, NF07 / F-05 | compareApplication; Browser E2E + API | Полное равенство записи POST после reload/relogin, статусы/поля/time в UI | not tested: новый запуск ожидается | updated_at не отображается UI; проверяется API, created_at — также datetime в UI |
| G01, NF06 / F-06 | подписанные dt/dd профиля; Browser E2E + API | ФИО/факультет/программа/направление/курс/группа совпадают с seed и API; чужого ФИО нет | not tested: новый запуск ожидается | Общий факультет студентов закономерно одинаковый |
| G01–G03 / F-07 | строки текущих дисциплин и Сессии; Browser E2E + API | Суммы/счётчики, ноль/нет оценки, текущий семестр, нет фиктивного долга/истории | not tested: новый запуск ожидается | Итоги/пересдачи/empty проверяются отдельным academics.browser и integration |
