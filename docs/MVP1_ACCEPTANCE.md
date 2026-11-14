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

## Матрица PRD §5 / REQ

Результаты относятся к review-исправлениям; CI и точный SHA указаны в PR #54.
Ожидаемое поведение проверяется assertions, не наличием тестового файла.

| REQ / локальный критерий | Конкретная проверка / уровень | Ожидаемый результат | Фактический результат / статус | Ограничение |
|---|---|---|---|---|
| A01–A05: вход/выход/сессия | auth.browser, access-expiry.browser; Browser E2E + API; auth integration | Login/reload, вкладки, true/false/unknown logout, отзыв access, независимое устройство, один replay | passed (локально и CI 43424818134) | Потери ответов моделируются fault proxy; реальные backend операции исполняются |
| NF03, NF06: два вымышленных аккаунта | demo-data.browser; Browser E2E + test_demo_seed integration | Оба студента проходят весь путь на 1440/360 | passed, четыре заявки | Одноразовые пароли только в env |
| G01: профиль и разные персональные данные | dt/dd профиля + /users/me; Browser E2E + API | ФИО, факультет, программа, направление, курс, группа совпадают с seed/API; прежний студент отсутствует | passed | Общий факультет ожидаем |
| S01–S02: старт, день/неделя | login + inspectMoves, schedule.browser; Browser E2E | После login расписание; desktop day/week, мобильный выбор даты | passed (demo локально; schedule CI 43424818134) | Мобильный интерфейс показывает выбранный день |
| S03–S04: время, преподаватели, аудитории, изменения | inspectMoves + /schedule; Browser E2E + API; schedule integration | 19→20→23 и 19→21, отмена, статусы, карточки по API, переход кнопкой и фокус | passed demo и integration | Начальные позиции компактные, аудитории проверяются на актуальных |
| G01–G03: оценки/сессия | строки двух таблиц demo; Browser E2E + /academics; academics integration/browser | Каждая дисциплина: сумма, число оценённых работ, ноль/нет оценки, текущая сессия; нет долга и истории | passed (demo/integration локально; academics CI 43424818134) | Итоговые оценки/пересдачи/empty — только специальные фикстуры |
| D01–D02: подача | submitAndRestore; Browser E2E + реальный POST | Услуга study_certificate, создание submitted/pending | passed | Обработка сотрудником/PDF вне MVP 1 |
| D03, NF07: сохранность | compareApplication после POST/reload/relogin; Browser E2E + API | Полное равенство GET результату POST: ID, услуга, form_data, оба статуса, timestamps; UI соответствует | passed | updated_at проверяется API, в UI нет такого поля; created_at также проверяется datetime |
| NEW01: новости | demo UI/API и специализированный `news.browser.mjs` | Полный заголовок/body, детали и возврат; отдельный suite покрывает 70 строк, keyset-страницы, историю и адаптивность | passed demo; специализированный suite подключён задачей TASK-023 | Итоги полного прогона и CI указаны в PR TASK-023 |
| N01: персональные уведомления | demo drawer; Browser E2E; NotificationsDrawer Vitest; auth integration | Разные уведомления, изоляция, открытие/закрытие | passed | Автогенерация событий вне MVP 1 |
| NF04: изоляция | реальные Bearer/anonymous, /applications/{id}, no-store, forbidden query; Browser E2E + API/integration | Разные выборки; чужой/отсутствующий ID одинаковый 404; без Bearer 401; подстановка 422 | passed | Сетевые UI-симуляции не называются серверной интеграцией |
| NF02, NF09–NF10: 360 px, состояния, навигация | demo UI menu/overflow; Browser E2E; функциональные browser suites; Vitest | Полный путь на обеих ширинах; loading/empty/error/retry/keyboard | passed (demo/Vitest; browser schedule/academics CI 43424818134) | Полный ручной accessibility-аудит — not tested |
| NF05: конкурсный прототип | StudentLayout.test; Vitest | Явный демостатус | passed | — |
| NF01: публичная ссылка | — | Проверка опубликованного сайта | TASK-020 | Не заменяется локальным smoke |
| NF08: доступ из России | — | Без VPN | TASK-020 | В этой задаче не выполняется |

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

`news.browser.mjs` запускается отдельным обязательным `news-browser-e2e` job
(TASK-023) на изолированной PostgreSQL с 70 новостями. Полный ручной аудит доступности,
production TLS, реальные устройства и доступ из России НЕ ПРОВЕРЕНЫ.

## Предыдущая приёмка до независимого ревью (история)

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
| A01–A05, NF04 / F-02 | auth.browser.mjs; Browser E2E с FastAPI/PostgreSQL и fault proxy | Вкладки, refresh/logout true/false/unknown, потерянные/поздние ответы, независимое устройство | passed (локально и CI 43424818134) | Управляемые сбои явно отделены от реальных ответов |
| S01–S04 / F-03 | inspectMoves; Browser E2E + API | 19→20→23, 19→21, отмена, время/аудитории, кнопка конечной позиции и фокус, desktop/360 | passed (локальный demo E2E) | Финальный seed не меняется |
| NEW01 / F-04 | demo E2E и отдельный `news.browser.mjs`; Browser E2E + API | Заголовок/полный body, даты 21/23; keyset-пагинация, 31-минутное чтение, Back/Forward, прямые ссылки, Ctrl+Click и адаптивность | demo E2E passed; специализированный suite запускается job TASK-023 | См. фактические повторы и результат CI в PR TASK-023 |
| D01–D03, NF07 / F-05 | compareApplication; Browser E2E + API | Полное равенство записи POST после reload/relogin, статусы/поля/time в UI | passed (локальный demo E2E) | updated_at не отображается UI; проверяется API, created_at — также datetime в UI |
| G01, NF06 / F-06 | подписанные dt/dd профиля; Browser E2E + API | ФИО/факультет/программа/направление/курс/группа совпадают с seed и API; чужого ФИО нет | passed (локальный demo E2E) | Общий факультет студентов закономерно одинаковый |
| G01–G03 / F-07 | строки текущих дисциплин и Сессии; Browser E2E + API | Суммы/счётчики, ноль/нет оценки, текущий семестр, нет фиктивного долга/истории | passed (локальный demo E2E) | Итоги/пересдачи/empty проверяются отдельным academics.browser и integration |

## Повторная проверка после ревью

Команды: `bash scripts/test-e2e-exit.sh`; `pytest -q`; `pytest -m integration -q`;
`npm test`; `npm run lint`; `npm run format:check`; `npm run typecheck`;
`npm run build`; `node frontend/e2e/demo-data.browser.mjs`;
`node frontend/e2e/access-expiry.browser.mjs`; `node frontend/e2e/auth.browser.mjs`.
Использованы те же locked версии и отдельные demo/expiry базы. Auth использует
штатный seed_services_browser_test_students, Vite API_PROXY_TARGET на fault proxy
:18080, настоящий API :8000 и uni_space_test после завершения integration suite.

Фактически повторено локально: 328 unit/HTTPX passed, 228 integration passed,
254 Vitest passed; frontend lint/format/typecheck/build passed; отрицательная
проверка двух pipeline passed (оба intentional exit 37 обнаружены); demo passed
на обоих студентах × обеих ширинах; expiry passed. Auth passed локально и в CI 43424818134. Полный финальный CI привязан к SHA
и ссылке в PR; эта запись не объявляет незавершённую job успешной. Продуктовые файлы и финальный seed не менялись.

Первый demo прогон после расширения остановился на точном accessible name
ссылки новости: имя включает дату и анонс. Селектор исправлен на пользовательскую
ссылку с заголовком внутри; повторный полный demo прогон passed без ослабления
assertions содержимого новости.
