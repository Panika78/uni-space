# uni-space

MVP2-07 (#72): защищённые ручные итоги аттестации (GET/POST/PATCH/DELETE),
пересдачи, текущий преподавательский scope и корректировка деканатом с
`grades.edit`. Все изменения атомарны с общим аудитом; no-op не аудируется.
Контракт — [API](docs/API.md), [аудит](docs/AUDIT.md).
PostgreSQL-проверки: `pytest -m integration tests/test_final_results_integration.py
 tests/test_final_results_acl.py` (для ACL нужен `psql` или `POSTGRES_TEST_CONTAINER`).
После миграций повторно применить `deploy/postgres/privileges.sql` к существующим
production volumes: права записи итогов, append-only аудита и блокировки проведения.


Конкурсный прототип университетского кабинета: расписание, успеваемость, заявки, новости и персональные уведомления.

## Авторские права

Оригинальный исходный код текущей версии Uni Space не предоставляется по лицензии MIT или другой открытой лицензии. См. [COPYRIGHT](COPYRIGHT). Лицензии сторонних компонентов действуют отдельно; это изменение не отзывает разрешения, уже выданные для ранее распространённых копий под MIT.

Инфраструктура MVP2-29: модель `audit_events`, транзакционный writer и безопасные
снимки реализованы миграцией `20261114_02` после RBAC `20261114_01`;
контракт и подключение в будущих предметных issues описаны в
[docs/AUDIT.md](docs/AUDIT.md). Предметные редакторы и API чтения аудита этим не добавляются.

MVP2-03: назначения преподавателей и защищённые read API журнала реализованы
в `/api/v1/teaching` (контракт — [API.md](docs/API.md)). Scope проверяется по
актуальному назначению на каждом запросе. Миграция `20261115_02` следует за
историей заявлений `20261115_01`; после upgrade повторите штатный
`scripts/migrate-postgres.sh` для SELECT-only ACL. Преподавательский CRUD,
выставление баллов/посещаемости и UI журнала в эту поставку не входят.
Проверки: `pytest -m integration tests/test_teaching_integration.py
tests/test_teaching_migrations.py`; общий прогон сохраняет проверки MVP1.

MVP2-04: добавлен API записи, исправления и очистки баллов по утверждённым
работам (`PUT /api/v1/teaching/courses/{course_offering_id}/groups/{group_id}/assessments/{assessment_group_id}/results/{student_id}`).
Для преподавателя проверяются актуальное назначение и членство студента в группе;
уполномоченный сотрудник деканата с эффективным `grades.edit` может исправлять
и очищать существующие исторические результаты. Проверяются диапазон баллов,
конкурентные изменения и атомарная запись событий в `audit_events`; повторное
сохранение того же значения не создаёт фиктивного изменения или аудита.
Новый API описан в [docs/API.md](docs/API.md); UI журнала, посещаемость, редактор
работ и ручные итоги не входят в MVP2-04.

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

## Основа RBAC (MVP2-01)

Добавлены профили сотрудников, независимые полномочия и серверные проверки
областей доступа. `GET /api/v1/auth/context` предоставляет актуальный read-only
контекст четырёх ролей для будущего frontend. Миграция `20261114_01` следует
за `20261112_03`; после upgrade повторите штатную настройку ACL. Выдача прав
и предметные редакторы остаются в следующих задачах. Контракты и правила
интеграции — [AUTH.md](docs/AUTH.md#основа-rbac-mvp2-01-60).
Специализированные проверки: `pytest -m integration tests/test_permissions_integration.py`;
они входят и в общий PostgreSQL-прогон.

## Ролевой каркас (MVP2-02)

`RoleAccess` получает сгенерированный `AuthorizationContext` через существующий
`apiFetch` и `GET /api/v1/auth/context`; `/cabinet` выбирает старт по серверной роли:
student `/schedule`, teacher `/teacher/journals`, admin `/admin/users`, staff
`/staff/applications` только при `applications.review`, иначе `/staff`.
Прямые URL другой роли показывают отказ до студенческих API. Для staff меню
строится по каждому эффективному grant независимо; без grants отображается
«Нет доступных разделов» с выходом. Пустые staff grants других ролей не запрещают их кабинеты.

`CabinetLayout` переиспользует sidebar, drawer, аватар и подтверждение выхода MVP1;
`StudentLayout` передаёт студенческие пункты и инициалы. `StudentAccess`, профиль,
защита форм и уведомления остаются в студенческом поддереве; другим ролям
не отправляется `/users/me` и не показываются студенческие профиль/настройки/bell.
Контекст обновляется при навигации (включая Back), focus/pageshow, видимости
вкладки и восстановлении сети. Профиль студента также перепроверяется при
возвращении видимости/сети. При временном network/5xx оба access-уровня сохраняют
уже проверенное дерево в памяти через `AccessRecovery`, скрывая его и блокируя
взаимодействие. Фокус переходит на ошибку; эффекты модальных окон, портальные
уведомления и автоматическое управление фокусом приостановлены. Защита формы
при Back/reload и единственный отправленный POST продолжают работать; восстановление
возвращает тот же экземпляр формы, включая pending/uncertain/подтверждение.
Первичная ошибка не открывает дерево, а 401/403 и смена сессии уничтожают его.
Длинная десктопная навигация прокручивается между закреплёнными брендом и кнопкой
сворачивания, включая 1440×500 и увеличенный текст. Новые порталы и эффекты
управления фокусом в защищённых модулях должны учитывать `useAccessSuspended()`. 401 обрабатывается существующим
`AuthSession`/API-клиентом, 403 не запускает refresh, network/5xx дают повтор чтения.
При logout/смене аккаунта штатная отмена запросов и очистка QueryClient удаляют
контекст и персональные данные; проверки поколения отбрасывают поздние ответы.

Интеграция следующих модулей: #80 заменяет состояние `/teacher/journals`,
#84 — `/staff/applications`, #78 — `/admin/users`; #61 сохраняет серверный read scope.
#82 и остальные staff-модули добавляют собственные маршруты под `RoleAccess` и
`RoleGuard`, заменяя соответствующие ссылки `/staff#<permission>` в
`getRoleNavigation`; #79 уже подключает права поиска и ручного статуса к отдельным
маршрутам. Якоря оставшихся модулей ведут к пояснениям на нейтральном экране и не
резервируют будущие доменные URL. `useRoleContext()` предоставляет роль,
подразделение и эффективные grants; это только представление, не авторизация API.
После предметного 403 можно актуализировать `['authorization-context']` через
QueryClient; серверная проверка предметной операции обязательна.
Журналы, редакторы и CRUD здесь не реализованы: только честные состояния
недоступности без записей и мутаций. Поиск студентов и статус реализованы в #79
на `/staff/students` и `/staff/students/status` с независимыми правами; прочие
будущие staff-модули пока остаются нейтральными состояниями.

Ролевые browser E2E используют реальный FastAPI/PostgreSQL. На отдельной локальной
`uni_space_test` после миграций подготовьте расписание (команда в разделе «Расписание студента»), запустите API и Vite с test-настройками, затем:

```bash
# PYTHONPATH=backend; APP_ENV=test; DATABASE_URL — localhost uni_space_test.
# Требуются uv, Playwright и Chromium, как для остальных browser E2E.
PLAYWRIGHT_MODULE="$PWD/work/browser-tooling/node_modules/playwright/index.mjs" node frontend/e2e/roles.browser.mjs
```

`frontend/e2e/role-fixtures.py` создаёт только вымышленные аккаунты на изолированной
локальной БД и меняет grants для проверки отзыва; production/backend API не меняются.
Тест проверяет все роли, три варианта staff, reload, реальные изменения прав,
360/1440 px, drawer/Back/Escape/клавиатуру/фокус, запрет чужого URL, смену аккаунта
и запоздалый контекст. Дополнительные ошибки контекста подменяются после реального
входа; успешные ролевые сценарии работают с настоящим API. CI запускает отдельную
job `roles-browser` вместе с прежними student/auth E2E.

## Поиск студентов и академический статус (MVP2-27)

`students.read` открывает `/staff/students`: поиск по ФИО/группе, фильтры и
серверная пагинация с Back/Forward и фильтрами в URL. Карточка
`/staff/students/:id` доступна напрямую и после reload. Независимое `students.status.edit` позволяет установить статус
по известному ID без доступа к общему поиску или ФИО. UI требует подтверждения
оформленного внешнего основания и явного выбора целевого статуса. Используется
PATCH; ожидание записи ограничено 15 секундами. Неопределённый ответ не повторяет
запись: GET-сверка доступна только с правом чтения, иначе нужна внешняя проверка.
Изменение статуса и запись аудита #87 атомарны,
`users.is_active` не меняется. API-контракт: [docs/API.md](docs/API.md#поиск-студентов-и-академический-статус-mvp2-27).

Новая таблица и миграция не нужны. Для production обновление штатного
`deploy/postgres/privileges.sql` выдаёт runtime роли только `UPDATE` столбца
`students.academic_status`, `INSERT` в `audit_events` и `SELECT(id, created_at)`
для `INSERT ... RETURNING`. Проверки: `pytest -m integration tests/test_staff_students_integration.py`
и `tests/test_application_workflow_acl.py`; browser E2E —
`PLAYWRIGHT_MODULE="$PWD/work/browser-tooling/node_modules/playwright/index.mjs" node frontend/e2e/staff-students.browser.mjs`.

## Workflow заявлений (MVP2-15)

Реализованы защищённые `/api/v1/staff/applications`, детали/история и действие
`review`, а также студенческие `resubmit` и `history` на существующем ID.
Сервер проверяет полномочия #60, подразделение, владельца, конечный автомат и
версию условным UPDATE; история сохраняется одной транзакцией с изменением.
Контракт — [docs/API.md](docs/API.md#workflow-заявлений-mvp2-15).

Миграция `20261115_01` добавляет `application_history` после `20261114_03`, без
вымышленной истории старых заявлений. В production запустите штатный
`scripts/migrate-postgres.sh`: повторное применение ACL после upgrade даёт
`uni_space_api` SELECT/INSERT истории, USAGE её sequence и UPDATE только
изменяемых workflow-столбцов заявления. UPDATE/DELETE истории не разрешены.
UI, ручные услуги/новые формы, вложения, PDF и уведомления остаются в отдельных
issues; `study_certificate` сохраняет автоматический режим без ручного одобрения.

Проверки: `pytest -m integration tests/test_application_workflow*.py`.
Тест настоящего production ACL использует `psql` из PATH; при запуске PostgreSQL
через Compose можно передать `POSTGRES_TEST_CONTAINER=uni-space-test-test-db-1`.
Он применяет `deploy/postgres/privileges.sql` в отдельной временной БД и выполняет
авторизованные HTTP-запросы через настоящее подключение `uni_space_api`.
Запускать только на изолированном тестовом PostgreSQL: штатный ACL управляет
кластерными ролями/CONNECT, как и при production-настройке.

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
`→ 20261112_02` (академические таблицы) `→ 20261112_03` (защита результатов)
`→ 20261114_01` (RBAC) `→ 20261114_02` (аудит)
`→ 20261114_03` (формальные подгруппы) `→ 20261115_01` (история заявлений) `→ 20261115_02` (назначения преподавателей)
`→ 20261115_03` (предпочтения расписания).
Используйте штатный upgrade существующей БД со схемой main; `alembic stamp`
не применяется. Экспериментальные БД старой, ещё не объединённой версии PR #47
имеют конфликтующие ID ревизий и требуют отдельной сверки схемы/истории перед
переносом данных; автоматически переименовывать их ревизии нельзя.

## Расписание студента (TASK-010, TASK-011, MVP2-10)

`GET /api/v1/schedule?date_from=2026-11-09&date_to=2026-11-15` требует существующий
Bearer и профиль студента. Обе даты обязательны, допускается 1–31 календарный день
включительно. Неизвестные параметры (в том числе `student_id`/`group_id`) дают 422.
Сервер выбирает занятия по актуальным `students.group_id` / `subgroup_id`
и фактическим `lesson_groups`, сортирует по `starts_at, id`; связанные группы и аудитории не размножают занятия.
Время ответа — UTC; календарь и отображение — `Europe/Moscow`. Занятие через
полночь видно на обеих пересекаемых датах, если оно актуально; старые перенесённые
и отменённые позиции показываются только на московской дате начала. Цепочки переносов возвращают
непосредственного предшественника и последнюю позицию за пределами диапазона;
позиции без назначения текущему студенту не раскрываются.

Отменённые и старые перенесённые позиции показываются компактными строками,
актуальные — полноценными карточками. Старые позиции используют `latest_lesson`;
отмена конечной позиции указана явно. Кнопка «Показать конечную позицию» выбирает
московскую дату начала, загружает нужную неделю и переводит фокус на запись,
сохраняя режим дня/недели. При недоступной позиции даты и перехода нет.
Временная ошибка загрузки не сбрасывает переход: после успешного повтора фокус
восстанавливается. Если целевая запись исчезла, выводится нейтральное сообщение.

Миграция `20261111_01` добавляет учебные периоды, дисциплины, проведения с
`attestation_type`, корпуса, аудитории и связи занятий. Таблицы аккаунтов,
студентов, преподавателей и групп используются повторно. Серии не создаются.
Для production используйте существующий `scripts/migrate-postgres.sh`:
он повторяет явную настройку ACL после миграций. Новые права — только SELECT
используемых расписанием таблиц; запись в расписание, его последовательности и
неиспользуемые справочники API недоступны. Подробнее — [PRODUCTION.md](docs/PRODUCTION.md).

MVP2-10 добавляет `subgroups` и nullable `subgroup_id` студента/назначения.
Старые назначения остаются общими, распределение студентов не угадывается:
студент с NULL видит только общие занятия. Составные FK защищают принадлежность
подгруппы группе; два частичных уникальных индекса запрещают точные дубли.
Две разные подгруппы допускаются на одном занятии, `groups` в JSON не дублируется.
Один предикат участников используется для списка и связанных позиций переносов;
число SQL-запросов не растёт с количеством занятий и глубиной цепочки.
Фактическое изменение набора участников увеличивает `Lesson.version` ровно на один;
повторное сохранение того же набора не меняет версию. Сервис блокирует занятие и
обновляет ранее загруженные назначения из БД перед сравнением наборов.
Назначения захватываются с NOWAIT: при конкурирующем прямом SQL возможен 55P03,
требующий отката и повтора всей транзакции вместо взаимной блокировки F-05.
При связанной оценочной работе смена подгрупп допустима, пока учебная группа
остаётся участником: новые назначения добавляются перед удалением старых.
Триггеры защищают последнее назначение также при конкурентном прямом SQL;
миграция `20261114_03` заменяет их и восстанавливает версии MVP1 при откате.
Внутренние сервисы проверяют назначения и атомарно меняют оба поля студента;
публичного API перевода/редактора нет. Контракт для #73 —
`app.schedule.participants.Participant`, `has_participant_overlap` и
`get_student_lesson_condition`: вся группа пересекается со своей подгруппой,
разные формальные подгруппы не пересекаются. Проверки —
`pytest -m integration tests/test_subgroups_integration.py tests/test_subgroups_migrations.py`.
Downgrade `20261114_03` отклоняется при непустом справочнике подгрупп:
распределение сначала требуется явно разобрать, автоматического удаления нет.

MVP2-14 (REQ-S05/S06): расписание показывает компактные окна от 45 минут
между объединёнными актуальными занятиями. Отмены и старые позиции переносов
не занимают время. Единый переключатель «Показывать отменённые» сохраняется
на сервере через `GET/PATCH /api/v1/users/me/preferences`; ошибки чтения и
сохранения сообщаются явно. Переход к скрытому отменённому результату переноса
временно открывает его с фокусом, не изменяя настройку.
Миграция `20261115_03` добавляет только `user_preferences` (JSONB с проверкой
единственного булева ключа, FK пользователя, время обновления).
Специализированные проверки: `pytest -m integration tests/test_preferences_integration.py tests/test_preferences_migrations.py`;
frontend — `gaps.test.ts`, `preferences.test.tsx`; браузерные сценарии включены
в существующую `schedule-browser` CI job. Перед production нужен обычный
`bash scripts/migrate-postgres.sh` (upgrade и повторное применение явных ACL); дополнительных переменных окружения нет.

MVP2-11: внутренний `app.schedule.conflicts.validate_lesson_conflicts(Session,
LessonProposal)` проверяет полное предполагаемое состояние до записи, используя
`Participant`, `validate_lesson_participants` и `has_participant_overlap` из #62.
`ConflictValidation.issues` содержит устойчивые `code`, `field`, `severity`,
а `blocking` / `warnings` разделяют результаты без имён и идентификаторов людей.
Проверяются все аудитории и назначения только пересекающихся `scheduled` позиций;
`lesson_id` исключает редактируемую запись, `source_lesson_id` — источник переноса.
Для восстановления передаётся предполагаемый `status="scheduled"`.
Официальный кандидат получает блокирующие конфликты, дополнительный — предупреждения,
в том числе отдельный `room_conflict`. Пустой или некорректный состав участников,
интервал без timezone/неположительной длительности и неизвестный статус блокируются.
Сервис не выполняет flush/commit/rollback, не меняет версии и не накладывает
несохранённые изменения Session на занятость БД; используется `no_autoflush`.
Будущий #74 отвечает за авторизацию исключаемых ID, версии, атомарную запись и
аудит, передаёт полный состав и вызывает проверку до изменений. Результат не
резервирует ресурсы от конкурентного создания разных занятий. HTTP API и CRUD
дополнительных занятий не добавлены. Специализированная проверка:
`pytest -m integration tests/test_schedule_conflicts_integration.py`.

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
node frontend/e2e/services-mvp2.browser.mjs
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
`services-mvp2.browser.mjs` проверяет полный каталог, адаптивность 360/1440 px,
успешную отправку выписки и бухгалтерской справки, а также недоступность отправки
академического отпуска до подключения обязательных вложений.
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

### Браузерная регрессия новостей (TASK-023)

`news-browser-e2e` запускает настоящий FastAPI, Vite и Playwright Chromium с
отдельной PostgreSQL. Фикстура требует пустую таблицу `news`, создаёт одного
вымышленного студента и ровно 70 опубликованных новостей с разными прошедшими
датами. ID новости для прямого открытия передаётся из фикстуры, а не задаётся
в тесте. Локальный прогон использует тот же скрипт и отдельный Compose project;
нужны Docker Compose, Python/uv и Node/npm из раздела «Требования».

Из корня проекта выполните:

```bash
npm install --global npm@11.19.1
uv python install 3.12.16
uv sync --locked --project backend --python 3.12.16
npm ci --prefix frontend
mkdir -p work/browser-tooling
npm install --prefix work/browser-tooling --no-save --package-lock=false playwright@1.57.0
node work/browser-tooling/node_modules/playwright/cli.js install --with-deps chromium --only-shell
NEWS_TEST_MANAGE_COMPOSE=1 PLAYWRIGHT_MODULE="$PWD/work/browser-tooling/node_modules/playwright/index.mjs" npm run --prefix frontend e2e:news
```

Команда запуска мигрирует выделенную БД и подготавливает фикстуры автоматически.
Она требует `APP_ENV=test` и базу `uni_space_test` на localhost; учётные данные
изолированы от `.env`. При `NEWS_TEST_MANAGE_COMPOSE=1` runner очищает и поднимает
только выделенный Compose project `uni-space-test`, а затем удаляет его с volume
при успехе, ошибке и прерывании; exit code браузерного теста сохраняется.
Файл с фиктивными credentials создаётся уникальным `mktemp` с правами `600`,
проверяется до генерации и удаляется cleanup trap.
Перед миграциями он проверяет, что порты 8000 и 5173 свободны. Vite использует
`--strictPort`, readiness подтверждается доступностью API/Vite endpoints и
runner контролирует собственные процессы до завершения браузера. Uvicorn access-log
отключён; исходные API/Vite журналы создаются с правами владельца и не печатаются
и не загружаются напрямую. При падении runner создаёт редактированные копии
`work/news-browser-api.safe.log` / `work/news-browser-vite.safe.log`; в CI вместе
со скриншотом загружаются только эти копии. Санитайзер рекурсивно обрабатывает
чувствительные ключи JSON, HTTP-заголовки и распространённые формы `key=value`
без учёта регистра; его regression-тесты проверяют редактирование и сохранение
безопасной диагностики. Это не универсальная гарантия для произвольных форматов.
Стандартные системные логи
GitHub Actions находятся вне этой обработки и могут показывать фиктивный
`POSTGRES_PASSWORD=test-only-password` для временного PostgreSQL service; это
публичные тестовые данные, не production-секрет. Браузерные ожидания ограничены
15 секундами.

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
Happy-path списка заявлений обязательно подтверждает HTTP 200 и реальные непустые данные до проверки геометрии; HTTP 500 в отдельном негативном контроле должен отклоняться той же проверкой. Loading/error/empty-сценарии моделируются отдельно. Матрица также проверяет читаемость подписей и отсутствие обрезания контролов при 100/150/200% текста.
`academics.browser.mjs` проверяет ширины 360, 390, 600, 640, 641, 721, 768, 900, 1050, 1440 и 2560 px с раскрытым/свёрнутым sidebar, табличную семантику и отдельную read-only фикстуру длинных строк при 100/150/200% текста.
`applications.browser.mjs` дополнительно проверяет native hit-testing названия, даты, статуса и свободной области, клавиатуру, Ctrl+Click, возврат фокуса и чипы статусов в списке/деталях на 360, 768 и 1440 px. В расписании по уточнению D-03 зачёркнуто только название отменённого/перенесённого занятия, а время остаётся обычным.
`applications-pagination.browser.mjs` проверяет R3-02: HTTP 403 при первом GET, refetch и догрузке скрывает весь кешированный список и его действия, удаляя только закрытый снимок этого query (включая защиту от повторного показа после последующего 500); временная ошибка сохраняет прежний снимок с предупреждением и retry. Read-only GET-фикстуры отказа также проверяют восстановление доступа и denied-состояние каталога без повтора; авторизация остаётся настоящей.
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

### MVP2-06: даты утверждённых работ

Преподаватель может подтвердить/перенести дату и явно снять/заменить связь с
занятием через PATCH дат работы ([контракт](docs/API.md#mvp2-06-подтверждение-дат-утверждённых-работ)).
Пакет своих групп одной работы атомарен; дата связанной scheduled-пары проверяется
в Europe/Moscow, отменённая/перенесённая связь не подтверждается. Аудит и no-op —
по [общему контракту #71/#74](docs/AUDIT.md). UI журнала остаётся задачей #80.
Новой миграции нет; для production повторить штатный `scripts/migrate-postgres.sh`
для применения колонковых ACL и append-only аудита. Отмену/перенос и установку
флага реализует #74 в своей транзакции с тем же аудитом.

### MVP2-25: пользователи и первоначальный администратор

`/admin/users` поддерживает поиск/пагинацию, создание четырёх ролей, привязку
свободного преподавателя, блокировку/разблокировку, подразделение и явные разрешения
сотрудника. Первоначальный пароль показывается один раз; при потере ответа POST
не повторяется, проверьте логин в списке. Reset/смена пароля — отдельная #66.

Первый admin: интерактивная `python -m app.admin.bootstrap` после миграций;
защищённый production-запуск и восстановление — в [PRODUCTION.md](docs/PRODUCTION.md).
Повторный bootstrap при любом существующем admin запрещён. Новых миграций нет;
production требует штатного повторного применения точечных ACL.

Проверки: PostgreSQL `tests/test_admin_integration.py`, `tests/test_admin_acl.py`;
браузер — `node frontend/e2e/admin.browser.mjs` при работающих API/Vite и
изолированной `uni_space_test` (переменные как для roles browser, включая
`PLAYWRIGHT_MODULE`). Сценарий добавлен в CI job `roles-browser`.
MVP2-05: независимая посещаемость по занятию и студенту, защищённые PUT/DELETE
для назначенного преподавателя и деканата с `attendance.edit`, собственное чтение
студентом с сохранёнными историческими отметками. Контракт — [API.md](docs/API.md),
аудит — [AUDIT.md](docs/AUDIT.md). После миграции необходимо повторно применить
production ACL по существующей процедуре [PRODUCTION.md](docs/PRODUCTION.md).

Тест `test_attendance_transactions.py` проверяет настоящие production ACL на
отдельной эфемерной БД. Для локального Compose-прогона задайте
`POSTGRES_TEST_CONTAINER=uni-space-test-test-db-1`; без этой переменной нужен
локальный `psql`. В CI используется PostgreSQL service container.

После исправлений F-01/F-03 миграция `20261116_03` сохраняет происхождение отметок
и текущую границу принадлежности студента. Уже существующие отметки без доказуемой
принадлежности исправляет только деканат; новые отметки за занятия до начала
такого учёта не создаются. Подробности и ограничения — в [DB.md](docs/DB.md#посещаемость).

### Backend официального редактора расписания (MVP2-12)

Защищённые `/api/v1/staff/schedule` предоставляют справочники, расписания группы,
преподавателя и аудитории, детали занятия и create/update/cancel/move/restore.
Требуется актуальное `schedule.edit` сотрудника деканата. Версии, конфликты #73,
аудит участников и пометки дат работ сохраняются транзакционно; UI #82 не включён.
Контракт: [API](docs/API.md), [аудит](docs/AUDIT.md). Перед запуском применить
`alembic upgrade head` (миграции `20261116_04` и `20261116_05`) и штатный production ACL script
для существующих volumes. Предыдущие миграции не меняются.
Проверки: `pytest -m integration tests/test_schedule_editor*.py` и регрессии
`tests/test_assessed_lesson_participants.py`; нужны PostgreSQL и runtime ACL.
