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
адресом TCP peer. Он задаёт HTTPS, сохраняет Host и удаляет Forwarded и
дополнительные forwarded Host/Port/Prefix. API явно доверяет только
`NGINX_PROXY_IP` (по умолчанию `172.30.19.2`), назначенному Nginx в `proxy`.
Выберите свободный RFC1918 subnet/IP в `PROXY_SUBNET`/`NGINX_PROXY_IP` на целевом
хосте. `PROXY_DYNAMIC_RANGE` должен быть частью subnet и исключать статический
IP Nginx: иначе API может занять его первым. По умолчанию динамический пул —
`172.30.19.128/25`; Nginx — `.2`. Не расширяйте доверие на всю сеть ради удобства. Production Settings
отклоняет публичные сети доверия, wildcard и некорректные сочетания флагов.
За дополнительным CDN/LB эта конфигурация будет видеть его IP: до публикации
нужна отдельно проверенная политика доверия **на Nginx**, а не доверие любому
входящему X-Forwarded-For. Текущий стенд рассчитан на прямое подключение к Nginx.

DB healthcheck выполняет аутентифицированный `SELECT 1` по TCP. API healthcheck
проверяет реальный HTTP и совпадение Alembic heads в доступной БД. Nginx ждёт
здоровый API; собственный healthcheck проверяет проксирование в API на
контейнерном loopback:8080. Docker healthchecks показывают состояние, но сами
по себе не перезапускают unhealthy-процесс и не заменяют внешний мониторинг.

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
export PROD_ENV_FILE=/private/uni-space/production.env
```

Отредактируйте файл: `RELEASE_TAG` = SHA проверяемого коммита (не `latest`),
`SERVER_NAME` = hostname, `ALLOWED_ORIGINS` = JSON-массив точных HTTPS-origin,
пути к файлам секретов и TLS — абсолютные. Пример с `<...>` не запускается;
не копируйте dev `.env.example`. Ключи должны быть случайными; шаблонная
проверка Settings не доказывает энтропию. Если случайный ключ случайно содержит
запрещённый маркер, сгенерируйте новый. Не выводите ключи в терминал/CI.

Секреты передаются через Compose file secrets, доступны только API и БД.
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

## Первая установка, запуск и диагностика

```bash
bash scripts/production-compose.sh config --quiet
bash scripts/production-compose.sh build
bash scripts/production-compose.sh up -d --wait db
bash scripts/production-compose.sh run --rm api alembic upgrade head
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
снаружи. Nginx не пишет query/body/cookie/Authorization в access log; backend не
логирует секреты. Ограничьте доступ и срок хранения логов; настройте ротацию Docker
логов на хосте. Не публикуйте полные дампы диагностики/окружения.

## Backup и безопасное отдельное восстановление

```bash
install -d -m 700 /private/uni-space/backups
bash scripts/backup-postgres.sh /private/uni-space/backups/pre-update.dump
bash scripts/restore-postgres.sh /private/uni-space/backups/pre-update.dump restore_verification
bash scripts/production-compose.sh exec db sh -c 'psql -U "$POSTGRES_USER" -d restore_verification -c "SELECT version_num FROM alembic_version"'
bash scripts/production-compose.sh run --rm -e DATABASE_NAME=restore_verification api python scripts/check_migrations.py
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
   перед обновлением нужен backup. Выполните `run --rm api alembic upgrade head`.
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
uv run --locked --python 3.12.12 --project backend python deploy/test_production.py
```

Тест создаёт уникальный project и временные секреты/сертификат, публикует Nginx
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
smoke-теста нет. В тестовый allowlist добавляется точный loopback HTTPS-origin
со случайным портом. Chromium доверяет только SPKI сгенерированного сертификата
через `--ignore-certificate-errors-spki-list`; глобального `ignoreHTTPSErrors` нет.
Основная HTTPX-проверка по-прежнему проверяет CA и hostname. Перед закрытием
браузера собираются ошибки ресурсов; недоступный JS/CSS не считается успехом.
В `finally` удаляет **только собственный** тестовый project с volume.
Не запускайте тест параллельно с другим стендом на том же proxy subnet.
GitHub Actions выполняет этот прогон отдельным job; остальные проверки — в README.

## Перед TASK-020

Выбрать провайдера/домен и проверить доступность из России без VPN; настроить DNS,
реальный TLS и продление, внешний firewall (только нужные 80/443 и защищённое
администрирование), Docker и свободные подсети, production-секреты/права/ротацию,
точный Origin, реальную цепочку proxy и клиентский IP. Назначить backup-хранилище,
расписание, retention, владельца и мониторинг ошибок; выполнить restore drill,
проверить HTTPS/auth/изоляцию/перезапуск на целевом хосте. Данные и аккаунты для
демонстрации готовятся отдельно по соответствующим задачам. Локальный успех
TASK-019 не доказывает безопасность и доступность фактического публичного сайта.
