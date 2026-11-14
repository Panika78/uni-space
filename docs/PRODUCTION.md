# Production-конфигурация (TASK-019)

Связанные требования: REQ-NF01, REQ-NF04, REQ-NF07; issue #20.
Это конфигурация и локально воспроизводимые проверки. Публичное размещение,
реальный домен/TLS и доступность из России относятся к TASK-020.
Продуктовые API и схема авторизации/БД здесь не расширяются.

## Устройство и ограничения

`compose.prod.yaml` запускается **самостоятельно**, без `compose.yaml`.
Последний остаётся средой разработки. Nginx — единственный опубликованный сервис
(80 → HTTPS, 443 → SPA/API). API подключён к внутренним `proxy` и `database`,
PostgreSQL — только к `database`; Nginx не подключён к сети БД. `postgres_data`
сохраняется при `down` и пересоздании. Не запускайте `down --volumes` для рабочих данных.
Доступ администратора к Docker/хосту эквивалентен доступу к секретам и данным.

API всегда использует существующий `python -m app.core.server --production`:
внешний `APP_ENV=development`, `.env` и Uvicorn defaults не понижают режим.
Один процесс Uvicorn сохраняет существующий process-local rate limiter;
не включайте несколько workers/реплик без отдельного решения по лимитам.

Nginx завершает TLS и **заменяет**, а не дополняет клиентский X-Forwarded-For
адресом TCP peer. Он задаёт HTTPS, передаёт канонический Host из `PUBLIC_ORIGIN`
и удаляет Forwarded и
дополнительные forwarded Host/Port/Prefix. API явно доверяет только
`NGINX_PROXY_IP` (по умолчанию `172.30.19.2`), назначенному Nginx в `proxy`.
Выберите свободный RFC1918 subnet/IP в `PROXY_SUBNET`/`NGINX_PROXY_IP` на целевом
хосте. `PROXY_DYNAMIC_RANGE` должен быть частью subnet и исключать статический
IP Nginx: иначе API может занять его первым. По умолчанию динамический пул —
`172.30.19.128/25`; Nginx — `.2`. Не расширяйте доверие на всю сеть ради удобства. Production Settings
принимает только отдельные приватные/loopback IP (либо `/32`, `/128`);
многоадресные CIDR, публичные адреса, wildcard и некорректные сочетания флагов отклоняются.
За дополнительным CDN/LB эта конфигурация будет видеть его IP: до публикации
нужна отдельно проверенная политика доверия **на Nginx**, а не доверие любому
входящему X-Forwarded-For. Текущий стенд рассчитан на прямое подключение к Nginx.

HTTPS-запросы с Host, отличным от authority `PUBLIC_ORIGIN`, отклоняются (421);
для HTTP проверяется hostname, редирект всегда ведёт на канонический HTTPS-origin.
Регистр hostname несущественен. Пустые/дублированные Host отклоняет HTTP parser (400).
Внутренние healthchecks сохраняют работу через закрытый loopback:8080. Дополнительный
TrustedHostMiddleware не требуется: граница доверия — Nginx, API не публикуется,
а upstream Host фиксирован конфигурацией. При изменении топологии это нужно пересмотреть.

DB healthcheck выполняет аутентифицированный `SELECT 1` по TCP. API healthcheck
проверяет реальный HTTP и совпадение Alembic heads в доступной БД. Nginx ждёт
здоровый API; собственный healthcheck проверяет проксирование в API на
контейнерном loopback:8080. Docker healthchecks показывают состояние, но сами
по себе не перезапускают unhealthy-процесс и не заменяют внешний мониторинг.

## Лицензии frontend-зависимостей и происхождение графики

Production-сборка Vite 7.3.7 включает `build.license` и создаёт
`frontend/dist/licenses.md`. Встроенный механизм Vite собирает записи только
для модулей зависимостей, реально вошедших в клиентские chunks, и включает
версию, SPDX-идентификатор (если указан пакетом) и найденный текст LICENSE.
Файл попадает в web image вместе с `dist` и доступен посетителям по
`/licenses.md`; CI проверяет его после сборки командой
`npm run check:licenses` из `frontend/`. Проверка сверяет каждую запись с
lock-файлом, запрещает dev-only пакеты и проверяет обязательные части текстов
MIT/Apache-2.0. Корневой [LICENSE](../LICENSE) проекта сохраняет MIT и не
подменяет лицензии включённых зависимостей. Точный корневой файл также
копируется в `dist/LICENSE`, доступный посетителям по `/LICENSE`; CI сравнивает
его с исходным файлом. Серверные Python- и системные
пакеты в этот перечень SPA не входят; условия их передачи проверяются отдельно
при распространении серверного образа.

Сообщённое происхождение оригинальных иллюстраций, изображений зданий и
университетской символики зафиксировано в `frontend/public/ASSET_PROVENANCE.md`;
Vite копирует его в `dist`, и файл доступен по `/ASSET_PROVENANCE.md`.
Uni Space — вымышленный университет, а графика сгенерирована пользователем с
помощью OpenAI ChatGPT. Эта запись не объявляет правовую охрану AI-графики
гарантированной, не назначает ей MIT и не утверждает обязательную атрибуцию
OpenAI.

Проект не принимает REUSE как обязательный стандарт. Отсутствие per-file SPDX
метаданных само по себе не нарушает условия лицензий, включённых в текущий
bundle; IP-02 остаётся необязательным улучшением для технического долга.
Массовое добавление SPDX-заголовков и `reuse lint` в эту задачу не входят.

## Базовые образы и security updates (SEC-01, PR #31)

Проверено 10 ноября 2026 года по официальным источникам:

| Компонент | Выбранный образ | Основание |
|---|---|---|
| Python | `python:3.12.16-slim-bookworm` | [Security release 3.12.16 от 25 октября](https://www.python.org/downloads/release/python-31216/); остаёмся в 3.12 |
| PostgreSQL | `postgres:17.11-bookworm` | [Release notes 17.11](https://www.postgresql.org/docs/17/release-17-11.html) и [поддерживаемые версии](https://www.postgresql.org/support/versioning/); остаёмся в major 17 |
| Nginx | `nginx:1.30.6-alpine` | [Stable download](https://nginx.org/en/download.html), [security advisories](https://nginx.org/en/security_advisories.html), [CHANGES-1.30](https://nginx.org/en/CHANGES-1.30); 1.28 — legacy, исправления текущих advisories есть в stable 1.30.6 |

Теги проверены в Docker registry; интеграционный тест проверяет версии
фактически запущенных бинарников Python/PostgreSQL/Nginx. Dockerfile и Compose закрепляют manifest
digest, чтобы тот же тег не менял используемые байты незаметно. При security update
нужно явно обновить версию **и digest**, повторить сборку и интеграционный прогон.
Для Python 3.12.16 используется patch-update uv 0.13.7: uv 0.13.5 ещё не содержит
метаданных этого Python. Lock зависимостей приложения не меняется.

Обновление PostgreSQL 17.6 → 17.11 не требует `pg_upgrade`/смены формата volume:
это minor update внутри 17. Перед ним всё равно остановите запись, сделайте backup,
прочитайте release notes 17.7–17.11 и проверьте используемые расширения. Текущая
схема не использует `btree_gist`, `ltree`, `pgcrypto` и logical decoding plugins,
для которых release notes описывают дополнительные действия. После обновления
проверьте контрольные записи, связи и Alembic heads; не удаляйте volume.
Смена major PostgreSQL сюда не входит. Разделение ролей SEC-02 описано ниже (TASK-022, issue #32).

### Проверка CVE собранных образов

10 ноября 2026 года выполнен разовый аудит **готовых** API и web images Trivy
0.76.2 (официальный release archive с проверенным SHA-256). PostgreSQL проверен
по закреплённому registry digest, платформа `linux/amd64`. Использована база
Trivy DB schema 2, `UpdatedAt=2026-11-10T01:02:55Z`; фильтр HIGH/CRITICAL,
без `ignore-unfixed` и без ignore-файлов. Это проверка images, а не Dockerfile
или дерева исходников. Числа — записи package/CVE, не уникальные CVE:

| Image | HIGH | CRITICAL |
|---|---:|---:|
| API (`010ac0eb5b47`) | 48 | 4 |
| SPA/Nginx (`8d48876b4dcf`) | 0 | 0 |
| PostgreSQL 17.11 (закреплённый digest) | 75 | 4 |

У API 42 записи относятся к системным пакетам Bookworm и 10 — к существующему
lock Python-зависимостей. В частности, scanner сообщает CRITICAL
`CVE-2026-102268` для PyJWT 2.10.1 (fixed 2.14.0) и `CVE-2026-63374` для
AnyIO 4.9.0 (fixed 4.14.2), HIGH для Starlette 0.46.2 (fixed до 1.3.1 в зависимости
от CVE). В системных пакетах есть записи без доступного Debian fixed version,
включая `fix_deferred`/`will_not_fix`. У PostgreSQL также есть находки в системных
пакетах и Go stdlib вспомогательного бинарника. **Применимость/эксплуатируемость
этих находок в Uni Space НЕ ПРОВЕРЕНА.** Они не исключались и не объявляются
устранёнными обновлением Python/PostgreSQL/Nginx.

Поэтому автоматический CVE gate с маскирующим baseline/исключениями в этот PR
не добавлен. Выбрана простая политика: при обновлении/release сканировать реальные
images, разбирать HIGH/CRITICAL до публикации; инфраструктурную ошибку scanner
не считать успешным аудитом. Обновление FastAPI/Starlette/PyJWT/AnyIO и оценка
системных CVE требуют отдельной работы с зависимостями и проверками авторизации;
этот PR не меняет lock или модель авторизации ради зелёного отчёта scanner.
Нулевые HIGH/CRITICAL у web не доказывают отсутствие других классов проблем.

Пример повторения после установки Trivy 0.76.2 из официального
[release](https://github.com/aquasecurity/trivy/releases/tag/v0.76.2) и проверки
release checksums; замените `YOUR_RELEASE_TAG` на собранный release:

```bash
mkdir -p work/image-audit
trivy image --cache-dir work/image-audit/cache --platform linux/amd64 --db-repository ghcr.io/aquasecurity/trivy-db:2 --scanners vuln --severity HIGH,CRITICAL --format json --output work/image-audit/api.json uni-space-api:YOUR_RELEASE_TAG
trivy image --cache-dir work/image-audit/cache --platform linux/amd64 --db-repository ghcr.io/aquasecurity/trivy-db:2 --scanners vuln --severity HIGH,CRITICAL --format json --output work/image-audit/web.json uni-space-web:YOUR_RELEASE_TAG
trivy image --cache-dir work/image-audit/cache --platform linux/amd64 --db-repository ghcr.io/aquasecurity/trivy-db:2 --scanners vuln --severity HIGH,CRITICAL --format json --output work/image-audit/postgres.json registry-1.docker.io/library/postgres@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994
```

Сохраняйте версию scanner, `metadata.json` базы, image IDs/digests, платформу
и JSON отчёты. База меняется: повторный аудит может дать другие результаты;
успешный exit code scanner без CVE gate означает завершение сканирования,
а не отсутствие CVE. Успех функционального CI тоже не является CVE-аудитом.

## Подготовка внешней конфигурации

Требуются версии инструментов из README, Compose >= 2.24.4 (`!override` нужен
только тесту), OpenSSL для тестового TLS. Все команды ниже — из корня репозитория.
Используйте отдельный приватный каталог **вне git**; замените пути под хост:

```bash
install -d -m 700 /private/uni-space
cp deploy/production.env.example /private/uni-space/production.env
chmod 600 /private/uni-space/production.env
umask 077
python -c 'import secrets; print(secrets.token_urlsafe(48))' > /private/uni-space/jwt_signing_key
python -c 'import secrets; print(secrets.token_urlsafe(48))' > /private/uni-space/postgres_password
python -c 'import secrets; print(secrets.token_urlsafe(48))' > /private/uni-space/api_db_password
python -c 'import secrets; print(secrets.token_urlsafe(48))' > /private/uni-space/migration_db_password
export PROD_ENV_FILE=/private/uni-space/production.env
```

Отредактируйте файл: `RELEASE_TAG` = SHA проверяемого коммита (не `latest`),
`PUBLIC_ORIGIN` — единственный публичный HTTPS-origin, например `https://uni.example`
или `https://uni.example:8443`. Hostname в нижнем регистре, без пути и завершающего `/`;
стандартный порт 443 опускается. Для нестандартного порта настройте публикацию
этого порта на Nginx:443 через Compose override/внешнюю сеть хостинга.
Compose выводит `ALLOWED_ORIGINS` API из этого значения, а entrypoint Nginx —
hostname и authority для Host и HTTPS-редиректов. Отдельные `SERVER_NAME` и
`ALLOWED_ORIGINS` из внешнего env больше не используются production Compose.
Backend отклоняет несовпадение `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` при ручном override;
пути к файлам секретов и TLS — абсолютные. Пример с `<...>` не запускается;
не копируйте dev `.env.example`. Ключи должны быть случайными; шаблонная
проверка Settings не доказывает энтропию. Если случайный ключ случайно содержит
запрещённый маркер, сгенерируйте новый. Не выводите ключи в терминал/CI.

Секреты передаются через Compose file secrets с раздельными mounts по ролям.
Entrypoint API читает их в окружение процесса; пароль URL-кодируется существующим
`URL.create()`. В image layers, Compose environment values и SPA секретов нет.
Compose secrets здесь — защищённые файлами mounts, **не шифрованное хранилище**.
Защитите исходные файлы и доступ к Docker. Пароль PostgreSQL применяется только
при инициализации пустого volume: смена файла не меняет пароль существующей роли.
Ротацию согласуйте с `ALTER ROLE` и пересозданием API, не удаляйте volume.
Смена JWT-ключа делает старые access недействительными; планируйте её отдельно.

TLS: установите fullchain и приватный ключ от выбранного CA; файлы монтируются
read-only. В тесте генерируется самоподписанный сертификат и клиент явно доверяет
ему, проверяя hostname; проверки TLS не отключаются. Тестовый сертификат нельзя
использовать при публикации. После продления реального сертификата пересоздайте
Nginx (важно при замене файла через rename), проверьте срок и цепочку снаружи.

## Роли PostgreSQL и переход существующего volume (TASK-022, SEC-02)

Связанные требования: REQ-NF04, REQ-NF07; issue #32.
Кластер выделен только этому приложению. Роли PostgreSQL не связаны с `users.role`.

| Подключение | Секрет / сервис | Права |
|---|---|---|
| `POSTGRES_USER` (прежнее имя сохраняется) | `POSTGRES_PASSWORD_FILE`, только `db` | Администратор кластера; bootstrap, backup, создание отдельной restore-БД |
| `uni_space_migrator` | `MIGRATION_DB_PASSWORD_FILE`, только `db` и одноразовый `migrate` | LOGIN без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS; владелец public и прикладных объектов, DDL миграций |
| `uni_space_api` | `API_DB_PASSWORD_FILE`, только `db` и `api` | CONNECT рабочей БД, USAGE public и последовательностей auth/applications; SELECT users, students, auth_sessions, refresh_tokens, alembic_version, справочников профиля/расписания (ниже), service_types, applications, news и notifications; INSERT applications; INSERT/UPDATE auth_sessions и refresh_tokens |

Явный демонстрационный seed — отдельная операторская операция, он не запускается
миграциями, API или Compose startup. Для текущей demo-конфигурации seed закрепляет
ожидаемую цель `db:5432/uni_space` и роль `uni_space_migrator`; эти значения не
вычисляются из `POSTGRES_DB`/`DATABASE_URL`. Перед любой записью seed проверяет
настройки и подключённую PostgreSQL (`current_database()`, `current_user`, адрес
и порт сервера), показывает фактическую цель и требует интерактивного ввода
подтверждения фиксированной demo-цели. Если production Compose настроен иначе,
запуск отклоняется. Инструкция явного запуска и резервного копирования находится
в [DEMO_DATA.md](DEMO_DATA.md#production). Эта операция не предназначена для
рабочей БД.

Для совместной работы TASK-009/010 явно разрешён только `SELECT` на
`study_groups`, `programs`, `org_units`, `teachers`,
`disciplines`, `course_offerings`, `buildings`, `rooms`, `lessons`, `lesson_groups`,
`lesson_rooms`. `academic_terms`/`course_groups` создаются миграцией как основа
учебной модели, но текущий API их не читает и прав на них не получает. Не выдаются
права записи или USAGE на последовательности расписания. Список разрешений в
`deploy/postgres/privileges.sql` применяется существующим migration wrapper до и
после Alembic, без широких default GRANT. Изолированный production-тест создаёт
вымышленные учебные фикстуры мигратором, повторяет ACL и выполняет настоящий
`GET /api/v1/users/me` и `GET /api/v1/schedule` через HTTPS под `uni_space_api`
для двух студентов, включая собственные учебные связи профиля, общую пару,
несколько аудиторий, цепочку переносов и изоляцию группы. Отдельно проверяет отказ
записи в справочники профиля/расписание, использования их последовательностей и
чтения лишних таблиц. Оба API проверяются также после восстановления БД и повторного ACL.

Для TASK-013 API может создавать собственные заявки: ему выданы `SELECT` на
`service_types`/`applications`, `INSERT` на `applications` и `USAGE` только на
`applications.id`. Для TASK-015 ему выдан только `SELECT` на `news`; запись в
`news` и права на её последовательность запрещены. Для TASK-016 уведомления доступны
runtime-роли только для чтения: `SELECT` на `notifications`, без DML и sequence USAGE.

API не получает административный или migration secret ни в окружение, ни в mounts.
API pool задаёт для каждого PostgreSQL-соединения `lock_timeout=5000ms` и
`statement_timeout=30000ms`. Это параметры сессии API-клиента; Alembic использует
отдельный engine с `NullPool`, а backup/restore и операторские команды запускаются
с отдельными подключениями и не получают API deadlines. Не добавляйте эти значения
в `ALTER ROLE` или `ALTER DATABASE`: такое наследование может ограничить миграции,
восстановление и обслуживание.
В `migrate` нет JWT-секрета приложения: константа удовлетворяет Settings только для
запуска Alembic, HTTP/token signing этим сервисом не выполняются. Образ общий,
секреты не встраиваются. API читает Alembic revision, но не меняет её.
`SELECT FOR UPDATE` пользователя при login требует UPDATE хотя бы одной колонки:
выдан только `UPDATE(id)` users; пароль, роль и активность менять нельзя.
Это ограничение PostgreSQL: обладатель SQL credentials может менять ID, если
ограничения целостности допускают это. Защита credentials и серверная авторизация
остаются необходимыми. Удаление сессий/токенов API сейчас не выполняет и не разрешено.
ALTER DEFAULT PRIVILEGES снимает права PUBLIC/API на новые таблицы,
последовательности и функции мигратора **глобально и в public**: schema-level
REVOKE не отменяет ранее выданный глобальный GRANT. Повторный bootstrap
устраняет такие grants. Migration wrapper выдаёт права только перечисленным
выше объектам. У текущего приложения нет SQL-функций/процедур; bootstrap также
отзывает PUBLIC/API EXECUTE у всех существующих routines в public, включая
SECURITY DEFINER. Для будущего вызова функции из API нужен явный пересмотр GRANT.

`configure-postgres.sh` выполняется явно, а не через initdb.d: одинаково для
пустого и уже заполненного volume. Команда атомарно создаёт/ограничивает роли,
передаёт только объекты public текущей БД мигратору, обновляет права и пароли
из файлов. Повторный запуск сохраняет данные. Не используйте имена зарезервированных
ролей как POSTGRES_USER; неожиданные membership требуют ручного разбора и дают отказ.
В выделенном кластере снимаются PUBLIC CONNECT/TEMP/CREATE со всех доступных БД;
API и мигратор получают CONNECT только рабочей БД. Не применяйте этот bootstrap
к общему кластеру сторонних приложений. Системные каталоги PostgreSQL с публичными
метаданными остаются видимыми; секретные pg_authid и посторонние данные недоступны.

Для **перехода существующей установки PR #31**:

1. Зафиксируйте release/env/revision, остановите запись: `stop nginx api` через
   production wrapper. Сделайте backup старой командой и сохраните старые образы.
2. Сохраните прежние POSTGRES_USER, POSTGRES_DB, POSTGRES_PASSWORD_FILE,
   PROD_PROJECT_NAME и volume. Создайте два новых случайных пароля вне git,
   задайте API_DB_PASSWORD_FILE/MIGRATION_DB_PASSWORD_FILE в приватном env.
   Новые пароли — минимум 32 символа, все три DB-пароля должны различаться.
3. Получите новую версию и соберите образы. Пересоздайте только контейнер БД:
   `bash scripts/production-compose.sh up -d --force-recreate --wait db`.
   Это добавляет mounts новых секретов/скриптов, volume сохраняется.
4. Выполните `bash scripts/migrate-postgres.sh`: bootstrap → Alembic как
   мигратор → повторная настройка существующих auth-таблиц. Тот же порядок
   используется для свежей установки. При ошибке остановитесь, API не запускайте.
5. Пересоздайте API/Nginx, проверьте health, login/refresh/logout, контрольные
   данные/FK и Alembic. Повторите migration wrapper и проверьте сохранность.

Для независимой проверки: `bash scripts/configure-postgres.sh`, затем
`bash scripts/production-compose.sh run --rm migrate alembic check` и
`bash scripts/production-compose.sh exec api sh docker-entrypoint.sh python scripts/check_migrations.py`.
Проверять роль следует SQL-запросом из engine API: `SELECT current_user, rolsuper,
rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user`;
ожидается uni_space_api и три false. Полный отрицательный набор выполняет тест ниже.
Не запускайте Alembic через API, даже если повторный upgrade head без DDL успешен.

Restore по-прежнему выполняет администратор; pg_restore делает SET ROLE мигратора,
чтобы восстановленные объекты имели правильного владельца. Новая БД создаётся с
connection limit 0; до открытия соединений снимается PUBLIC/API CONNECT. Проверяйте
её через `migrate`/администратора. API не получает доступ ко всем restore-БД.
Для реального переключения после проверки измените POSTGRES_DB, пересоздайте db,
выполните migration wrapper (он переназначит CONNECT выбранной БД), затем API/Nginx.
Рабочая исходная БД при restore не меняется. Перед переключением обязательно
остановите все API-контейнеры проекта (включая одноразовые `run api`). Wrapper
проверяет DATABASE_NAME реально работающих контейнеров, а не только обновлённый
env: при другой или неизвестной runtime-БД отказывает **до изменения ACL**.
Обычный повторный bootstrap той же БД при работающем API разрешён. Команды
администрирования и запуск API выполняйте последовательно: проверка Docker не
является блокировкой от параллельного запуска контейнера другим оператором.
Защита действует в `scripts/configure-postgres.sh`; прямой запуск внутреннего
DB-скрипта администратором не заменяет этот wrapper.
Ротация новых паролей применяется
повторным bootstrap при остановленном API, затем пересозданием API/migrate.

Откат приложения возможен только при совместимой схеме и сохранении новой
конфигурации подключения API. Возврат прежнего Compose вернёт admin credentials
в API и повторно откроет SEC-02; это не безопасный штатный откат.

## Первая установка, запуск и диагностика

```bash
bash scripts/production-compose.sh config --quiet
bash scripts/production-compose.sh build
bash scripts/production-compose.sh up -d --wait db
bash scripts/migrate-postgres.sh
bash scripts/production-compose.sh up -d --wait --wait-timeout 120
bash scripts/production-compose.sh ps
bash scripts/production-compose.sh exec api sh docker-entrypoint.sh python scripts/check_migrations.py
bash scripts/production-compose.sh exec nginx nginx -t
curl --fail https://YOUR_HOST/api/openapi.json
curl --fail https://YOUR_HOST/schedule
bash scripts/production-compose.sh logs --tail 100 api db nginx
```

Не передавайте секреты в build args или `VITE_*`. В среде с TLS-inspecting proxy
передайте публичный CA как необязательный BuildKit secret `proxy_ca` в обе сборки;
TLS verification оставьте включённой. Сама production-конфигурация этого CA
не требует. Пример команд локального стенда приведён ниже.

При unhealthy DB проверьте пароль **существующей роли**, volume и файловые права.
При unhealthy API проверьте миграции и доступ к DB; при 502 — API/DNS в сети proxy.
Origin должен включать схему и порт (если нестандартный), без пути; refresh/logout
из CLI также требуют Origin. Проверяйте HTTPS cookie, ошибки Origin и rate limiter
снаружи. Refresh-cookie production использует `__Host-uni_space_refresh`, `Secure`
и `Path=/` без `Domain`; при переходе со старого имени пользователям потребуется
повторный login. Перед rollout сообщите об этом клиентам и убедитесь, что SPA и API
обслуживаются через HTTPS. В production launcher явно передаёт `--no-access-log` Uvicorn
(SEC-03, PR #31), включая защиту от внешнего `UVICORN_ACCESS_LOG=true`.
Единственный access log ведёт Nginx: IP, метод, `$uri` **без query string**, статус.
Он задан в публичных `server`-блоках: второй `access_log` на уровне `http`
добавлял бы безопасный журнал рядом со штатным `main`, а не заменял его.
Локальный healthcheck server не ведёт access log.
Uvicorn startup/error logging и существующие безопасные сообщения API с типом
исключения и request ID сохраняются; development/test access logs не меняются.
Не передавайте секреты в URL даже при таком журналировании: они могут попасть
в историю браузера, внешние proxy или другие системы. Гарантия удаления query
относится к access logs; инфраструктурные error logs могут содержать URI. Регрессионный прогон
отправляет вымышленный query-маркер настоящему API через HTTPS и HTTP redirect, проверяет его
отсутствие в API/Nginx logs при наличии безопасной строки Nginx. Unit/HTTPX-тест
на реальном процессе Uvicorn дополнительно вызывает ошибку соединения с тестовой
БД и подтверждает, что ошибка с request ID продолжает логироваться. Ограничьте доступ и срок хранения логов; настройте ротацию Docker
логов на хосте. Не публикуйте полные дампы диагностики/окружения.

## Backup и безопасное отдельное восстановление

```bash
install -d -m 700 /private/uni-space/backups
bash scripts/backup-postgres.sh /private/uni-space/backups/pre-update.dump
bash scripts/restore-postgres.sh /private/uni-space/backups/pre-update.dump restore_verification
bash scripts/production-compose.sh exec db sh -c 'psql -U "$POSTGRES_USER" -d restore_verification -c "SELECT version_num FROM alembic_version"'
bash scripts/production-compose.sh run --rm -e DATABASE_NAME=restore_verification migrate python scripts/check_migrations.py
```

`pg_dump` создаёт consistent custom-format snapshot одной БД (не роли кластера и
не TLS/секреты). Backup публикуется атомарно с правами 600, существующий файл не
перезаписывается. Имена ролей/секреты и release SHA сохраняйте отдельно защищённо.
Restore создаёт **новую** пустую БД с префиксом `restore_`, запрещает рабочую БД,
выполняется одной транзакцией с проверкой ошибок. Существующую БД не очищает и
не перезаписывает. При ошибке restore новая БД может остаться пустой: изучите
причину, удаляйте только её после проверки имени или выберите новое имя.

Сверьте контрольные записи, связи и версию Alembic; затем выполните auth smoke
на изолированном окружении восстановленной БД. Встроенный тест сравнивает все
поля контрольных users/auth_sessions/refresh_tokens, включая историю ротации,
и Alembic. Рабочую БД он не открывает. Не считайте `pg_restore` без ошибок
достаточной проверкой прикладных данных.

При аварийном переключении остановите запись: `stop nginx api`, восстановите
в новую БД, проверьте её совместимым образом, измените `POSTGRES_DB` во внешнем
env-файле на имя восстановленной БД, пересоздайте `db` (без удаления volume),
затем `api nginx`. Новое `POSTGRES_DB` **не создаёт** БД в существующем volume;
она уже должна быть восстановлена. Старую БД оставьте до отдельного решения.
Учтите потерю записей после snapshot. Не меняйте имя Compose-проекта: оно задаёт
имя volume. `PROD_PROJECT_NAME` предназначено для явно изолированных окружений.

При TASK-020 назначьте владельца, расписание (например, системный cron/timer с
явным `PROD_ENV_FILE` и абсолютным путём к checkout), уникальные имена backup,
срок хранения, проверку ошибок/свободного места и уведомления. Храните копии
шифрованно вне этого хоста, ограничивайте доступ, периодически проверяйте restore
в изолированной среде. Секреты и backup содержат чувствительные данные.
Реальное место хранения и расписание остаются TBD; ни cron, ни облако не создаются.

## Обновление и откат

1. Запишите текущий release SHA, конфигурацию и Alembic revision. Изучите новые
   миграции и совместимость старого/нового образа со схемой.
2. Получите проверенный commit, задайте новый `RELEASE_TAG`, выполните `build`.
   Сохраните предыдущие образы; для переноса на другой хост сохраните их в
   согласованном registry/archive. Этот процесс не настраивает автодеплой.
3. Для несовместимых изменений остановите `nginx api`, прекратив запись; сделайте
   backup командой выше и проверьте восстановление. Даже при совместимых миграциях
   перед обновлением нужен backup. Выполните `bash scripts/migrate-postgres.sh`.
4. `up -d --force-recreate --wait --wait-timeout 120 api nginx`, затем health,
   HTTPS SPA/API, auth/Origin/cookie и контрольные записи. Внутренний proxy IP
   сохраняется при пересоздании Nginx. Простой при обновлении допустим.
5. Если схема совместима с предыдущим образом, верните прежний `RELEASE_TAG`
   и пересоздайте API/Nginx с сохранением volume. **Откат образа не откатывает БД.**
   Если несовместима — остановите запись, восстановите проверенный pre-update
   backup в новую БД, проверьте предыдущим образом и переключите конфигурацию.
   Обратные миграции выполняйте только после отдельной оценки; универсальный
   безопасный `alembic downgrade` не обещается.

## Воспроизводимый интеграционный стенд

Используются Python/uv/HTTPX, Docker, OpenSSL, Node и внешний Playwright/Chromium
(тот же подход, что в `frontend/e2e/auth.browser.mjs`). Зависимости приложения
не меняются. Для браузерного smoke-теста установите изолированные инструменты:

```bash
npm install --prefix work/browser-tooling --no-save --package-lock=false playwright@1.57.0
node work/browser-tooling/node_modules/playwright/cli.js install chromium --only-shell
export PLAYWRIGHT_MODULE="$PWD/work/browser-tooling/node_modules/playwright/index.mjs"
```

Системные библиотеки Chromium должны быть установлены; CI использует
`install --with-deps chromium --only-shell` на закреплённом Ubuntu 24.04:
Playwright 1.57.0 не поддерживает Ubuntu 26.04 из `ubuntu-latest`.
Если Chromium уже есть в окружении,
задайте `CHROMIUM_PATH=/absolute/path/to/chromium`; `PLAYWRIGHT_MODULE` может
указывать на уже установленный Playwright. Отсутствие браузера/Playwright приводит
к ошибке прогона, а не пропуску проверки.
Должны быть свободны `172.30.19.0/24` и место для Docker images/build cache.
В обычной среде флаг `--secret` можно опустить; здесь он нужен только proxy CA:

```bash
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f backend/Dockerfile -t uni-space-api:task019 .
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f deploy/Dockerfile.web -t uni-space-web:task019 .
uv run --locked --python 3.12.16 --project backend python deploy/test_production.py
```

Тест дважды создаёт уникальный project (свежая БД и admin-owned volume PR #31) и временные секреты/сертификат, публикует Nginx
только на случайных loopback-портах. Проверяет readiness до/после миграций,
HTTPS со строгой проверкой тестового CA, SPA fallback/JSON 404, auth-cookie,
Origin, схему HTTPS, два клиентских IP и лимиты при spoofing, недоверенного peer,
отказы реальной production-команды при небезопасных параметрах (даже с внешним
development), backup/restore, повторное применение миграций, пересоздание с
сохранением volume, отсутствие секретов в логах/config/bundle.
Проверка неизвестного `/schedule/deep/link` через HTTP подтверждает только
Nginx fallback. Дополнительно `deploy/spa.browser.mjs` открывает зарегистрированный
`/schedule` в новой вкладке Chromium шириной 360 px: проверяет реальные JS/CSS
(200, корректный MIME, применение CSS), отсутствие ошибок загрузки и JS-исключений,
настоящий `401` refresh без cookie и редирект React на `/login` с формой входа.
Никаких browser route mocks, фиктивных endpoint или тестовых данных для этого
smoke-теста нет. Единый тестовый `PUBLIC_ORIGIN` — `https://uni.test:<случайный порт>`.
Локальное разрешение имени направляет `uni.test` на loopback, сохраняя URL, Host и SNI.
Chromium доверяет только SPKI сгенерированного сертификата
через `--ignore-certificate-errors-spki-list`; глобального `ignoreHTTPSErrors` нет.
HTTPX строго проверяет CA, hostname `uni.test` и срок действия, фиксирует SNI.
Тестовый сертификат не содержит IP SAN: обращение по IP отклоняется. Подписанные
тем же доверенным CA сертификаты с чужим SAN и истёкшим сроком поочерёдно
подаются настоящим Nginx и отклоняются с соответствующими ошибками TLS. Перед закрытием
браузера собираются ошибки ресурсов; недоступный JS/CSS не считается успехом.
В `finally` удаляет **только собственный** тестовый project с volume.
Не запускайте тест параллельно с другим стендом на том же proxy subnet.
GitHub Actions выполняет этот прогон отдельным job; остальные проверки — в README.

Регрессии security-review F-02/F-03 намеренно выдают мигратору небезопасные
глобальные и schema-level defaults TABLES/SEQUENCES/FUNCTIONS для PUBLIC/API,
создают старые объекты, повторяют bootstrap при работающем API и создают новые.
Проверяются pg_default_acl, эффективные ACL pg_class/pg_proc и отказ вызова
старой/новой SECURITY DEFINER-функции из настоящего подключения API.
Для F-04 проверяется отказ переключения на restore-БД при работающем API,
неизменность database ACL и работоспособность нового соединения с источником;
после остановки API переключение и HTTPS auth проходят. Обратное переключение
также блокируется по runtime-БД, даже если Compose по-прежнему указывает источник.

## Зафиксированные проверки TASK-022

10 ноября 2026 года на изолированной PostgreSQL 17.11: 310 unit/HTTPX и
108 integration-тестов backend прошли; двойной upgrade head, alembic check и
проверка heads успешны. Ruff/lock/shell syntax и dev Compose healthcheck
(верный → неверный → восстановленный пароль) прошли. Production-образы собраны
из исходных Dockerfile с проверкой TLS. Полный production-прогон выше проверяет
свежую БД и admin-owned volume, отрицательные права, действующий старый refresh,
HTTPS/auth, отдельный restore и сохранность источника; итог полного прогона и
GitHub Actions фиксируется в PR TASK-022.

**НЕ ПРОВЕРЕНО:** реальные production-данные/хост, публичные DNS/TLS/firewall,
доступность из России, реальная ротация секретов и внешнее хранение/расписание
backup. Использованы только изолированные стенды и вымышленные данные;
публичный deploy не выполняется. Существующие CVE/SEC-04 из PR #31 остаются
за пределами TASK-022; новый CVE-аудит не выполнялся.

## Перед TASK-020

Выбрать провайдера/домен и проверить доступность из России без VPN; настроить DNS,
реальный TLS и продление, внешний firewall (только нужные 80/443 и защищённое
администрирование), Docker и свободные подсети, production-секреты/права/ротацию,
точный Origin, реальную цепочку proxy и клиентский IP. Назначить backup-хранилище,
расписание, retention, владельца и мониторинг ошибок; выполнить restore drill,
проверить HTTPS/auth/изоляцию/перезапуск на целевом хосте. Данные и аккаунты для
демонстрации готовятся отдельно по соответствующим задачам. Локальный успех
TASK-019 не доказывает безопасность и доступность фактического публичного сайта.
