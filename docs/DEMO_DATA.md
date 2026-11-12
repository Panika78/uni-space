# Демонстрационные данные MVP 1

`backend/scripts/seed_demo_data.py` — отдельная явная команда для демонстрационной
БД. Скрипт использует уже существующие таблицы и роли; миграции и запуск API его
не вызывают. На первом запуске база после миграций должна быть пустой, кроме
`service_types`, созданной миграцией. Первый запуск также откажет, если в таблице
заявок уже есть записи. Повторный запуск на той же БД безопасен: seed обновляет
только свой демонстрационный набор, не создаёт, не меняет и не удаляет заявки.

## Даты и содержимое

Учебный период: 1 сентября 2026 — 31 января 2027. План семестра сформирован по
вымышленным недельным шаблонам, которые раскрываются в отдельные `lessons`;
серий и повторяющихся занятий в модели/API нет. Время занятий задано для
`Europe/Moscow`. Демонстрационное окно начинается 8 ноября 2026 года; три новости
опубликованы 8–10 ноября. Специальные изменения расписания относятся к четвергу,
19 ноября 2026 года: лабораторная ПЗ-101 в УЛК отменена, занятие по введению в
зельеварение перенесено с 19 на 20 ноября в ГУК и затем с 20 на 23 ноября, а
практикум ПМ-201 перенесён с 19 на 21 ноября в Северную башню. Позиции переноса
связаны через `previous_lesson_id`; новость описывает эти конкретные записи.

Даты фиксированы для согласованной демонстрации, а не вычисляются от даты
запуска. После 31 января 2027 года период перестанет считаться текущим в
`GET /academics`; к демонстрации после этой даты потребуется отдельное изменение
содержимого/дат. Не запускайте seed для «сдвига» учебного периода: он не удаляет
старые записи и не переотносит пользовательские данные.

## Локальный запуск

Сначала создайте `.env` по README, поднимите PostgreSQL и примените миграции.
Запустите из корня репозитория в Bash. Пароли введите интерактивно: они не
сохраняются в файлах, аргументах команды или логах.

```bash
set -a
source .env
set +a
read -r -s -p 'Пароль ПЗ-101: ' DEMO_STUDENT_A_PASSWORD; printf '\n'
read -r -s -p 'Пароль ПМ-201: ' DEMO_STUDENT_B_PASSWORD; printf '\n'
export DEMO_STUDENT_A_PASSWORD DEMO_STUDENT_B_PASSWORD
export DEMO_SEED_ALLOWED_DATABASE="$POSTGRES_DB"
export DEMO_SEED_ALLOWED_HOST=db
export DEMO_SEED_CONFIRM="SEED_UNI_SPACE_DEMO_DATA:$POSTGRES_DB@db"
docker compose run --rm \
  -e DEMO_STUDENT_A_PASSWORD -e DEMO_STUDENT_B_PASSWORD \
  -e DEMO_SEED_ALLOWED_DATABASE -e DEMO_SEED_ALLOWED_HOST -e DEMO_SEED_CONFIRM \
  api python scripts/seed_demo_data.py
unset DEMO_STUDENT_A_PASSWORD DEMO_STUDENT_B_PASSWORD DEMO_SEED_CONFIRM
```

Команда сверяет базу и host из `DATABASE_URL` с явно указанной целью,
подтверждение должно содержать точные значения. В `development`/`test` допускается
отдельная целевая БД; первое применение откажет, если в ней уже есть записи
университетского справочника, расписания, новостей или уведомлений. Роль
`uni_space_api` всегда отклоняется. Имена демонстрационных учётных записей:
`demo-pz101` и `demo-pm201`.

Для повторного применения на этой же БД повторите команду, передав те же пароли.
Идентификаторы и статусы пользовательских заявок останутся нетронутыми. Скрипт
не предназначен для частичного восстановления после ручного удаления только
одного demo-аккаунта: он безопасно откажет.

## Production

Используйте только после резервной копии и проверки, что выбранная рабочая БД
предназначена для этой демонстрации. Загрузите пароли студентов в переменные
окружения из защищённого хранилища/интерактивного ввода; не кладите их в
`PROD_ENV_FILE`, git, CI или Docker build args. `PROD_ENV_FILE` должен указывать
на отдельный файл production-конфигурации с доступом к migration secret.

```bash
export PROD_ENV_FILE=/absolute/private/path/production.env
set -a
source "$PROD_ENV_FILE"
set +a
read -r -s -p 'Пароль ПЗ-101: ' DEMO_STUDENT_A_PASSWORD; printf '\n'
read -r -s -p 'Пароль ПМ-201: ' DEMO_STUDENT_B_PASSWORD; printf '\n'
export DEMO_STUDENT_A_PASSWORD DEMO_STUDENT_B_PASSWORD
export DEMO_SEED_ALLOWED_DATABASE="$POSTGRES_DB"
export DEMO_SEED_ALLOWED_HOST=db
export DEMO_SEED_CONFIRM="SEED_UNI_SPACE_DEMO_DATA:$POSTGRES_DB@db"
export DEMO_SEED_ALLOW_PRODUCTION=YES_I_HAVE_A_BACKUP
bash scripts/production-compose.sh run --rm -T \
  -e DEMO_STUDENT_A_PASSWORD -e DEMO_STUDENT_B_PASSWORD \
  -e DEMO_SEED_ALLOWED_DATABASE -e DEMO_SEED_ALLOWED_HOST \
  -e DEMO_SEED_CONFIRM -e DEMO_SEED_ALLOW_PRODUCTION \
  migrate python scripts/seed_demo_data.py
unset DEMO_STUDENT_A_PASSWORD DEMO_STUDENT_B_PASSWORD DEMO_SEED_CONFIRM DEMO_SEED_ALLOW_PRODUCTION
```

Production operation запускается отдельным one-off контейнером `migrate` под
`uni_space_migrator`, не под runtime-ролью API. Команда требует точное ручное
подтверждение host/database, специальный флаг backup и отклоняет любую иную роль.
Повторный seed не является восстановлением backup и не заменяет проверку состояния
записей после команды.
