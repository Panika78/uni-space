import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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
  const query = useQuery({
    queryKey: ['admin-options', kind, q, after],
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      read<Options>(
        `/lookups?kind=${kind}&q=${encodeURIComponent(q)}${after ? `&after_id=${after}` : ''}`,
        signal,
      ),
  })
  const label = {
    groups: 'Учебная группа',
    teachers: 'Свободный преподаватель',
    org_units: 'Подразделение',
  }[kind]
  return (
    <fieldset>
      <legend>{label}</legend>
      <label>
        Поиск в справочнике
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setAfter('')
          }}
        />
      </label>
      {query.isPending ? (
        <p role="status">Загрузка вариантов…</p>
      ) : query.isError ? (
        <p role="alert">
          {errorText(query.error)}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Повторить
          </button>
        </p>
      ) : (
        <>
          <label>
            {label}
            <select required value={value} onChange={(e) => onChange(e.target.value)}>
              <option value="">Выберите…</option>
              {value && !query.data.items.some((i) => i.id === value) && (
                <option value={value}>Выбрано: {value}</option>
              )}
              {query.data.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · ID {item.id}
                  {item.context ? ` · ${item.context}` : ''}
                  {item.type ? ` (${item.type})` : ''}
                </option>
              ))}
            </select>
          </label>
          {query.data.items.length === 0 && <p>Подходящих записей нет.</p>}
          {after && (
            <button type="button" onClick={() => setAfter('')}>
              Начало справочника
            </button>
          )}
          {query.data.next_after_id && (
            <button type="button" onClick={() => setAfter(query.data.next_after_id ?? '')}>
              Следующие варианты
            </button>
          )}
        </>
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
      <h1>Пользователи</h1>
      <Link to="/admin/users/new">Создать пользователя</Link>
      <form
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
          <ul className="admin-user-list">
            {query.data.items.map((user) => (
              <li key={user.id}>
                <Link to={`/admin/users/${user.id}`}>
                  {user.full_name} · {user.login}
                </Link>
                <span>
                  {roles[user.role]} · {user.is_active ? 'Активен' : 'Заблокирован'}
                </span>
              </li>
            ))}
          </ul>
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
        <h1 tabIndex={-1} ref={secretHeading}>
          Пользователь создан
        </h1>
        <p>{created.user.login}</p>
        <p>
          Сохраните пароль сейчас и безопасно передайте пользователю. После закрытия получить его
          повторно нельзя.
        </p>
        <p>
          Первоначальный пароль:{' '}
          <strong className="admin-secret">{created.initial_password}</strong>
        </p>
        <button onClick={() => setCreated(null)}>Закрыть и удалить пароль с экрана</button>
        <Link onClick={() => setCreated(null)} to={`/admin/users/${created.user.id}`}>
          Открыть учётную запись
        </Link>
      </section>
    )
  return (
    <section className="admin-users">
      <h1>Создание пользователя</h1>
      <Link to="/admin/users">К списку пользователей</Link>
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
          onSubmit={async (e) => {
            e.preventDefault()
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
          <label>
            Логин
            <input name="login" required maxLength={256} autoComplete="off" />
          </label>
          <label>
            ФИО
            <input name="full_name" required maxLength={256} />
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
          <p>Пароль сгенерирует сервер. Он будет показан один раз после создания.</p>
          <button disabled={busy}>{busy ? 'Создаём…' : 'Создать'}</button>
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
      await write<Detail>(`/users/${id}/${path}`, method, body)
      await query.refetch()
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
      <section className="admin-users" aria-labelledby="password-reset-title">
        <h1 id="password-reset-title" tabIndex={-1}>
          Пароль сброшен
        </h1>
        <p>
          Сохраните пароль сейчас и безопасно передайте пользователю. После закрытия получить его
          повторно нельзя.
        </p>
        <p>
          Выданный пароль: <strong className="admin-secret">{resetPassword}</strong>
        </p>
        <button onClick={() => setResetPassword(null)}>Закрыть и удалить пароль с экрана</button>
      </section>
    )
  if (query.isPending) return <p role="status">Загрузка учётной записи…</p>
  if (query.isError)
    return (
      <section className="admin-users">
        <h1>Пользователь</h1>
        <p role="alert">{errorText(query.error)}</p>
        <button onClick={() => void query.refetch()}>Повторить</button>
        <Link to="/admin/users">К списку</Link>
      </section>
    )
  const user = query.data
  const availableSections = staffSections.filter((section) =>
    user.available_permission_codes?.includes(section.permission),
  )
  const selectedCode = availableSections.some((section) => section.permission === code)
    ? code
    : availableSections[0]?.permission
  const academic = selectedCode !== 'applications.review' && selectedCode !== 'news.publish'
  return (
    <section className="admin-users">
      <h1>{user.full_name}</h1>
      <Link to="/admin/users">К списку пользователей</Link>
      <p>Логин: {user.login}</p>
      <p>
        {roles[user.role]} · {user.is_active ? 'Активен' : 'Заблокирован'}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {resetUncertain && (
        <p role="alert">
          Не удалось подтвердить результат сброса. Пароль мог измениться, но восстановить выданный
          секрет нельзя. Проверьте состояние с пользователем перед новым сбросом.
        </p>
      )}
      {user.id !== actor.user_id && (
        <button
          disabled={busy || resetting}
          onClick={async () => {
            if (!window.confirm('Сбросить пароль? Новый случайный пароль будет показан один раз.'))
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
      {user.student_id && (
        <p>
          Профиль студента: {user.student_id}, группа: {user.group_id}
        </p>
      )}
      {user.teacher_id && <p>Профиль преподавателя: {user.teacher_id}</p>}
      {user.staff_profile_id && (
        <>
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
          <ul>
            {user.permissions.map((grant) => (
              <li key={grant.permission_code}>
                {staffSections.find((s) => s.permission === grant.permission_code)?.label} · scope:{' '}
                {grant.scope_org_unit_id ?? 'все группы'}{' '}
                <button disabled={busy} onClick={() => void change('permissions', 'DELETE', grant)}>
                  Отозвать {grant.permission_code}
                </button>
              </li>
            ))}
          </ul>
          {user.permissions.length === 0 && <p>Разрешений нет.</p>}
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
        </>
      )}
    </section>
  )
}
