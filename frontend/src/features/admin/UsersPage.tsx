import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, ApiClientError, isDefinitiveApiRejection } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { staffSections } from '../auth/roleNavigation'
import { useRoleContext } from '../auth/RoleContext'
import './admin.css'

type Detail = components['schemas']['UserDetail']
type Create = components['schemas']['CreateUser']
type Grant = components['schemas']['PermissionGrant']
type Page = components['schemas']['UserPage']
type Options = components['schemas']['LookupPage']
type LookupItem = components['schemas']['LookupItem']
const base = '/api/v1/admin'
const roles = {
  student: 'Студент',
  teacher: 'Преподаватель',
  staff: 'Сотрудник',
  admin: 'Администратор',
}
function read<T>(path: string, signal?: AbortSignal) {
  return apiFetch<T>(base + path, { authenticated: true, signal })
}
function write<T>(path: string, method: string, body: unknown) {
  return apiFetch<T>(base + path, { authenticated: true, method, body: JSON.stringify(body) })
}
function errorText(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'Доступ запрещён. Проверьте полномочия.'
    if (error.status === 404) return 'Учётная запись не найдена.'
    if (error.status === 409)
      return 'Действие отклонено: логин или преподаватель уже занят, либо блокировка недопустима. Обновите данные.'
    if (error.status === 422) return 'Проверьте профиль, подразделение и область разрешения.'
  }
  return 'Не удалось выполнить запрос. Проверьте соединение.'
}

function isResetPasswordResponse(value: unknown): value is { password: string } {
  if (typeof value !== 'object' || value === null || !('password' in value)) return false
  const password = value.password
  return typeof password === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(password)
}

function ProfileSelect({
  kind,
  value,
  onChange,
}: {
  kind: 'groups' | 'teachers' | 'org_units'
  value: string
  onChange: (value: string) => void
}) {
  const [q, setQ] = useState('')
  const [after, setAfter] = useState('')
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [selected, setSelected] = useState<LookupItem | null>(null)
  const root = useRef<HTMLFieldSetElement>(null)
  const listboxId = useId().replaceAll(':', '')
  const query = useQuery({
    queryKey: ['admin-options', kind, q, after],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      read<Options>(
        `/lookups?kind=${kind}&q=${encodeURIComponent(q)}${after ? `&after_id=${after}` : ''}`,
        signal,
      ),
  })
  const items = query.data?.items ?? []
  const current =
    items.find((item) => item.id === value) ?? (selected?.id === value ? selected : null)
  const label = {
    groups: 'Учебная группа',
    teachers: 'Свободный преподаватель',
    org_units: 'Подразделение',
  }[kind]
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  function choose(item: LookupItem) {
    setSelected(item)
    onChange(item.id)
    setOpen(false)
    setQ('')
  }
  return (
    <fieldset className="admin-profile-picker" ref={root}>
      <legend>{label}</legend>
      <label>
        Поиск и выбор
        <input
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${listboxId}-options`}
          aria-activedescendant={
            open && activeIndex >= 0 && activeIndex < items.length
              ? `${listboxId}-option-${activeIndex}`
              : undefined
          }
          autoComplete="off"
          required={!value}
          value={open ? q : (current?.name ?? (value ? `Выбрано: ${value}` : ''))}
          placeholder={open ? 'Введите название для поиска' : 'Нажмите и начните вводить'}
          onFocus={() => {
            setOpen(true)
            setQ('')
            setAfter('')
            setPreviousCursors([])
            setActiveIndex(0)
          }}
          onChange={(e) => {
            setQ(e.target.value)
            setAfter('')
            setPreviousCursors([])
            setOpen(true)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false)
              setQ('')
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((index) => Math.min(index + 1, items.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && open && activeIndex >= 0 && items[activeIndex]) {
              event.preventDefault()
              choose(items[activeIndex])
            }
          }}
        />
      </label>
      {value && !open && (
        <span className="admin-profile-picker__selected">
          <button
            type="button"
            onClick={() => {
              onChange('')
              setSelected(null)
            }}
            aria-label={`Очистить ${label}`}
          >
            Очистить
          </button>
        </span>
      )}
      {open && (
        <div className="admin-profile-picker__popup">
          {query.isPending && <p role="status">Загрузка вариантов…</p>}
          {query.isError && (
            <p role="alert">
              {errorText(query.error)}{' '}
              <button type="button" onClick={() => void query.refetch()}>
                Повторить
              </button>
            </p>
          )}
          {!query.isPending && !query.isError && items.length === 0 && (
            <p role="status">Подходящих записей нет.</p>
          )}
          {!query.isError && items.length > 0 && (
            <ul id={`${listboxId}-options`} role="listbox" aria-label={label}>
              {items.map((item, index) => (
                <li
                  id={`${listboxId}-option-${index}`}
                  key={item.id}
                  role="option"
                  aria-selected={item.id === value}
                  data-value={item.id}
                  className={index === activeIndex ? 'is-active' : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    ID {item.id}
                    {item.context ? ` · ${item.context}` : ''}
                    {item.type ? ` · ${item.type}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!!previousCursors.length && (
            <button
              type="button"
              onClick={() => {
                setAfter(previousCursors.at(-1) ?? '')
                setPreviousCursors((cursors) => cursors.slice(0, -1))
                setActiveIndex(0)
              }}
            >
              Предыдущие варианты
            </button>
          )}
          {query.data?.next_after_id && (
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => {
                setPreviousCursors((cursors) => [...cursors, after])
                setAfter(query.data?.next_after_id ?? '')
                setActiveIndex(0)
              }}
            >
              {query.isFetching ? 'Загружаем…' : 'Следующие варианты'}
            </button>
          )}
        </div>
      )}
    </fieldset>
  )
}

export function UsersPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const after = params.get('after_id') ?? ''
  const query = useQuery({
    queryKey: ['admin-users', q, after],
    queryFn: ({ signal }) =>
      read<Page>(
        `/users?q=${encodeURIComponent(q)}${after ? `&after_id=${encodeURIComponent(after)}` : ''}`,
        signal,
      ),
    gcTime: 0,
  })
  return (
    <section className="admin-users">
      <p className="section-eyebrow">Администрирование</p>
      <h1>Пользователи</h1>
      <p className="admin-users__intro">Управление учётными записями и полномочиями.</p>
      <div className="admin-users__toolbar">
        <Link className="admin-users__create" to="/admin/users/new">
          ＋ Создать пользователя
        </Link>
      </div>
      <form
        className="admin-users__search-form"
        onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          setParams({ q: String(form.get('q') ?? '') })
        }}
      >
        <label>
          Логин или ФИО
          <input key={q} name="q" defaultValue={q} maxLength={256} />
        </label>
        <button>Найти</button>
      </form>
      {query.isPending ? (
        <p role="status">Загрузка пользователей…</p>
      ) : query.isError ? (
        <p role="alert">
          {errorText(query.error)} <button onClick={() => void query.refetch()}>Повторить</button>
        </p>
      ) : (
        <>
          {query.data.items.length === 0 && <p>Пользователи не найдены.</p>}
          <div className="admin-users__table-wrap">
            <table className="admin-users__table">
              <thead>
                <tr>
                  <th scope="col">Пользователь</th>
                  <th scope="col">Логин</th>
                  <th scope="col">Роль</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">{user.full_name}</th>
                    <td>{user.login}</td>
                    <td>{roles[user.role]}</td>
                    <td>
                      <span className={`admin-users__status${user.is_active ? '' : ' is-blocked'}`}>
                        <i aria-hidden="true" />
                        {user.is_active ? 'Активен' : 'Заблокирован'}
                      </span>
                    </td>
                    <td>
                      <Link className="admin-users__detail" to={`/admin/users/${user.id}`}>
                        Подробнее <span aria-hidden="true">→</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {after && <button onClick={() => setParams({ q })}>Начало списка</button>}
          {query.data.next_after_id && (
            <button onClick={() => setParams({ q, after_id: query.data.next_after_id! })}>
              Следующая страница
            </button>
          )}
        </>
      )}
    </section>
  )
}

export function CreateUserPage() {
  const [role, setRole] = useState<Create['role']>('student')
  const [profile, setProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState<string | null>(null)
  // Secret exists only in this mounted component, never in React Query/history/storage.
  const [created, setCreated] = useState<components['schemas']['CreatedUser'] | null>(null)
  const mounted = useRef(true)
  const secretHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (created) secretHeading.current?.focus()
  }, [created])
  if (created)
    return (
      <section className="admin-users">
        <p className="section-eyebrow">Администрирование</p>
        <article className="admin-users__result-card" aria-labelledby="user-created-title">
          <h1 id="user-created-title" tabIndex={-1} ref={secretHeading}>
            Пользователь создан
          </h1>
          <p>
            Учётная запись <strong>{created.user.login}</strong> готова.
          </p>
          <p>
            Сохраните пароль сейчас и безопасно передайте пользователю. После закрытия получить его
            повторно нельзя.
          </p>
          <p>
            Первоначальный пароль:
            <strong className="admin-secret">{created.initial_password}</strong>
          </p>
          <div className="admin-users__result-actions">
            <button onClick={() => setCreated(null)}>Закрыть и удалить пароль с экрана</button>
            <Link onClick={() => setCreated(null)} to={`/admin/users/${created.user.id}`}>
              Открыть учётную запись
            </Link>
          </div>
        </article>
      </section>
    )
  return (
    <section className="admin-users">
      <Link className="admin-users__back" to="/admin/users">
        ‹ К списку пользователей
      </Link>
      <p className="section-eyebrow">Администрирование</p>
      <h1>Новый пользователь</h1>
      <p className="admin-users__intro">
        Создание учётной записи и назначение первоначальной роли.
      </p>
      {error && <p role="alert">{error}</p>}
      {uncertain !== null ? (
        <p role="alert">
          Ответ на создание не получен. Учётная запись могла быть создана. POST не будет повторён.{' '}
          <Link to={`/admin/users?q=${encodeURIComponent(uncertain)}`}>
            Проверить список по логину
          </Link>
          . Если пароль неизвестен, вход недоступен до административного сброса в #66.
        </p>
      ) : (
        <form
          className="admin-users__create-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (role !== 'admin' && !profile) {
              setError('Выберите профиль из результатов поиска.')
              return
            }
            if (inFlight.current) return
            inFlight.current = true
            setBusy(true)
            setError('')
            const form = new FormData(e.currentTarget)
            const login = String(form.get('login'))
            const data: Create = {
              login,
              full_name: String(form.get('full_name')),
              role,
              ...(role === 'student'
                ? { group_id: profile }
                : role === 'teacher'
                  ? { teacher_id: profile }
                  : role === 'staff'
                    ? { org_unit_id: profile }
                    : {}),
            }
            try {
              const result = await write<components['schemas']['CreatedUser']>(
                '/users',
                'POST',
                data,
              )
              if (mounted.current) setCreated(result)
            } catch (err) {
              if (mounted.current) {
                if (
                  !(err instanceof ApiClientError) ||
                  !err.status ||
                  err.status >= 500 ||
                  err.code === 'invalid_response'
                )
                  setUncertain(login)
                else setError(errorText(err))
              }
            } finally {
              inFlight.current = false
              if (mounted.current) setBusy(false)
            }
          }}
        >
          <h2>Данные пользователя</h2>
          <label>
            <span>
              Фамилия, имя, отчество <span aria-hidden="true">*</span>
            </span>
            <input aria-label="ФИО" name="full_name" required maxLength={256} />
          </label>
          <label>
            <span>
              Логин <span aria-hidden="true">*</span>
            </span>
            <input aria-label="Логин" name="login" required maxLength={256} autoComplete="off" />
          </label>
          <label>
            Роль
            <select
              aria-label="Роль"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as Create['role'])
                setProfile('')
              }}
            >
              {Object.entries(roles).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {role !== 'admin' && (
            <ProfileSelect
              key={role}
              kind={role === 'student' ? 'groups' : role === 'teacher' ? 'teachers' : 'org_units'}
              value={profile}
              onChange={setProfile}
            />
          )}
          {role === 'teacher' && (
            <p>
              ФИО будет взято из выбранной существующей записи преподавателя. Учебные назначения
              сохраняются.
            </p>
          )}
          <p className="admin-users__security-note">
            <strong>Безопасность доступа</strong>
            <span>
              Пароль сгенерирует сервер и покажет один раз после создания. Назначение учётных данных
              выполняется через защищённый backend.
            </span>
          </p>
          <div className="admin-users__actions">
            <Link className="admin-users__cancel" to="/admin/users">
              Отмена
            </Link>
            <button aria-label={busy ? 'Создаём' : 'Создать'} disabled={busy}>
              {busy ? 'Создаём…' : 'Создать пользователя'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

export function UserDetailPage() {
  const { id } = useParams()
  return <UserDetailContent key={id} id={id!} />
}

function UserDetailContent({ id }: { id: string }) {
  const actor = useRoleContext()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['admin-user', id],
    queryFn: ({ signal }) => read<Detail>(`/users/${id}`, signal),
    gcTime: 0,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resetPassword, setResetPassword] = useState<string | null>(null)
  const [resetUncertain, setResetUncertain] = useState(false)
  const [unit, setUnit] = useState('')
  const [code, setCode] = useState<Grant['permission_code']>('applications.review')
  async function change(path: string, method: string, body: unknown) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await write<Detail>(`/users/${id}/${path}`, method, body)
      queryClient.setQueryData(['admin-user', id], updated)
      setNotice('Изменения сохранены.')
    } catch (err) {
      setError(errorText(err))
      await query.refetch()
    } finally {
      setBusy(false)
    }
  }
  if (resetPassword !== null)
    return (
      <section className="admin-users admin-user-detail" aria-labelledby="password-reset-title">
        <div className="admin-user-detail__heading">
          <Link to="/admin/users">‹ К списку пользователей</Link>
          <p className="section-eyebrow">Администрирование</p>
          <h1 id="password-reset-title" tabIndex={-1}>
            Пароль сброшен
          </h1>
        </div>
        <article className="admin-user-detail__notice">
          <p>
            Сохраните пароль сейчас и безопасно передайте пользователю. После закрытия получить его
            повторно нельзя.
          </p>
          <p>
            Выданный пароль: <strong className="admin-secret">{resetPassword}</strong>
          </p>
          <button onClick={() => setResetPassword(null)}>Закрыть и удалить пароль с экрана</button>
        </article>
      </section>
    )
  if (query.isPending) return <p role="status">Загрузка учётной записи…</p>
  if (query.isError)
    return (
      <section className="admin-users admin-user-detail">
        <div className="admin-user-detail__heading">
          <Link to="/admin/users">‹ К списку пользователей</Link>
          <p className="section-eyebrow">Администрирование</p>
          <h1>Карточка пользователя</h1>
        </div>
        <article className="admin-user-detail__notice">
          <p role="alert">{errorText(query.error)}</p>
          <button onClick={() => void query.refetch()}>Повторить</button>
        </article>
      </section>
    )
  const user = query.data
  const availableSections = staffSections.filter(
    (section) =>
      user.available_permission_codes?.includes(section.permission) &&
      !user.permissions.some((grant) => grant.permission_code === section.permission) &&
      !(
        section.permission === 'students.read' &&
        user.permissions.some((grant) => grant.permission_code === 'students.status.edit')
      ),
  )
  const selectedCode = availableSections.some((section) => section.permission === code)
    ? code
    : availableSections[0]?.permission
  const academic = selectedCode !== 'applications.review' && selectedCode !== 'news.publish'
  return (
    <section className="admin-users admin-user-detail">
      <div className="admin-user-detail__heading">
        <Link to="/admin/users">‹ К списку пользователей</Link>
        <p className="section-eyebrow">Администрирование</p>
        <h1>Карточка пользователя</h1>
        <h2 className="admin-user-detail__subtitle">{user.full_name}</h2>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {resetUncertain && (
        <p role="alert">
          Не удалось подтвердить результат сброса. Пароль мог измениться, но восстановить выданный
          секрет нельзя. Проверьте состояние с пользователем перед новым сбросом.
        </p>
      )}
      <div className={`admin-user-detail__grid${user.staff_profile_id ? ' has-permissions' : ''}`}>
        <article className="admin-user-detail__card">
          <h2>Данные учётной записи</h2>
          <dl className="admin-user-detail__facts">
            <div>
              <dt>ФИО</dt>
              <dd>{user.full_name}</dd>
            </div>
            <div>
              <dt>Логин</dt>
              <dd>{user.login}</dd>
            </div>
            <div>
              <dt>Роль</dt>
              <dd>{roles[user.role]}</dd>
            </div>
            <div>
              <dt>Состояние</dt>
              <dd>
                <span className={`admin-users__status${user.is_active ? '' : ' is-blocked'}`}>
                  <i />
                  {user.is_active ? 'Активен' : 'Заблокирован'}
                </span>
              </dd>
            </div>
            {user.student_id && (
              <div>
                <dt>Профиль студента</dt>
                <dd>
                  ID {user.student_id} · группа {user.group_id}
                </dd>
              </div>
            )}
            {user.teacher_id && (
              <div>
                <dt>Профиль преподавателя</dt>
                <dd>ID {user.teacher_id}</dd>
              </div>
            )}
            {user.staff_profile_id && (
              <div>
                <dt>Профиль сотрудника</dt>
                <dd>ID {user.staff_profile_id}</dd>
              </div>
            )}
          </dl>
          {user.id !== actor.user_id && (
            <button
              disabled={busy || resetting}
              onClick={async () => {
                if (
                  !window.confirm('Сбросить пароль? Новый случайный пароль будет показан один раз.')
                )
                  return
                setResetting(true)
                setResetUncertain(false)
                setError('')
                try {
                  const result = await apiFetch<components['schemas']['ResetUserPassword']>(
                    `${base}/users/${id}/password-reset`,
                    { authenticated: true, replayAfterRefresh: false, method: 'POST' },
                  )
                  if (!isResetPasswordResponse(result)) {
                    setResetUncertain(true)
                    return
                  }
                  setResetPassword(result.password)
                  setError('')
                  void query.refetch()
                } catch (resetError) {
                  if (isDefinitiveApiRejection(resetError)) {
                    const statusMessage =
                      resetError.status === 403
                        ? 'Сброс отклонён: недостаточно прав.'
                        : resetError.status === 404
                          ? 'Сброс отклонён: учётная запись не найдена.'
                          : resetError.status === 409
                            ? 'Сброс отклонён: операция недопустима для этой учётной записи.'
                            : resetError.status === 422
                              ? 'Сброс отклонён: проверьте запрос.'
                              : 'Сервер вернул ошибку при сбросе пароля.'
                    setError(statusMessage)
                  } else {
                    setResetUncertain(true)
                  }
                } finally {
                  setResetting(false)
                }
              }}
            >
              {resetting ? 'Сбрасываем…' : 'Сбросить пароль'}
            </button>
          )}
          <button
            disabled={busy || user.id === actor.user_id}
            onClick={() => {
              if (
                window.confirm(
                  user.is_active
                    ? 'Заблокировать пользователя и отозвать все его сессии?'
                    : 'Разблокировать пользователя? Потребуется новый вход.',
                )
              )
                void change('active', 'PUT', { is_active: !user.is_active })
            }}
          >
            {user.is_active ? 'Заблокировать' : 'Разблокировать'}
          </button>
          {user.id === actor.user_id && <p>Самоблокировка запрещена.</p>}
        </article>
        {user.staff_profile_id && (
          <article className="admin-user-detail__card admin-user-detail__permissions">
            <h2>Подразделение и разрешения</h2>
            <p>Текущее подразделение: {user.org_unit_id}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (window.confirm('Сменить подразделение? Все прежние разрешения будут отозваны.'))
                  void change('department', 'PUT', { org_unit_id: unit })
              }}
            >
              <ProfileSelect kind="org_units" value={unit} onChange={setUnit} />
              <button disabled={busy || !unit || unit === user.org_unit_id}>
                Сменить подразделение и отозвать права
              </button>
            </form>
            <h3>Текущие разрешения</h3>
            <ul className="admin-user-detail__grants">
              {user.permissions.map((grant) => (
                <li key={grant.permission_code}>
                  {staffSections.find((s) => s.permission === grant.permission_code)?.label} ·
                  scope: {grant.scope_org_unit_id ?? 'все группы'}{' '}
                  <button
                    disabled={busy}
                    onClick={() => void change('permissions', 'DELETE', grant)}
                  >
                    Отозвать {grant.permission_code}
                  </button>
                </li>
              ))}
            </ul>
            {user.permissions.length === 0 && <p>Разрешений нет.</p>}
            {availableSections.length ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void change('permissions', 'PUT', {
                    permission_code: selectedCode,
                    scope_org_unit_id: academic ? null : user.org_unit_id,
                  })
                }}
              >
                <label>
                  Разрешение
                  <select
                    aria-label="Разрешение"
                    value={selectedCode ?? ''}
                    onChange={(e) => setCode(e.target.value as Grant['permission_code'])}
                  >
                    {availableSections.map((s) => (
                      <option key={s.permission} value={s.permission}>
                        {s.label} ({s.permission})
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  {academic
                    ? 'Все учебные группы. Доступно только сотрудникам деканата.'
                    : 'Только текущее подразделение сотрудника.'}
                </p>
                <button disabled={busy || !selectedCode}>Выдать разрешение</button>
              </form>
            ) : (
              <p role="status">Все доступные разрешения уже выданы.</p>
            )}
          </article>
        )}
      </div>
    </section>
  )
}
