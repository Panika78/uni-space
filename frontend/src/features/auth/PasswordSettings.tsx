import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { CabinetLayout, UserMenu } from '../../app/CabinetLayout'
import { getStudentInitials } from '../profile/StudentProfile'
import { studentNavigation } from '../../app/StudentLayout'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { AccessRecovery, isTemporaryAccessError } from '../../shared/ui/AccessRecovery'
import { getRoleNavigation, getStartRoute } from './roleNavigation'
import { useRoleContext } from './RoleContext'
import { useAuth } from './AuthProvider'
import type { Profile } from '../profile/profileContext'
import './passwordSettings.css'

export function PasswordSettingsPage() {
  const context = useRoleContext()
  if (context.role === 'student') return <StudentPasswordSettings />
  return (
    <CabinetLayout navigation={getRoleNavigation(context)} home={getStartRoute(context)}>
      <PasswordSettingsForm />
    </CabinetLayout>
  )
}

function StudentPasswordSettings() {
  const query = useQuery({
    queryKey: ['student-profile'],
    queryFn: ({ signal }) => apiFetch<Profile>('/api/v1/users/me', { authenticated: true, signal }),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const forbidden = query.error instanceof ApiClientError && query.error.status === 403
  const canRecover = query.data !== undefined && isTemporaryAccessError(query.error)
  if (query.isPending) return <LoadingState title="Загружаем профиль…" />
  if (query.isError && !canRecover) {
    return (
      <ErrorState
        title={forbidden ? 'Доступ запрещён' : 'Не удалось загрузить профиль'}
        description={
          forbidden
            ? 'Студенческий кабинет доступен только студентам.'
            : 'Проверьте соединение и повторите попытку.'
        }
        onRetry={forbidden ? undefined : () => void query.refetch()}
      >
        <UserMenu logoutOnly />
      </ErrorState>
    )
  }
  if (!query.data) return null
  const failure = (
    <ErrorState
      title="Не удалось загрузить профиль"
      description="Проверьте соединение и повторите попытку."
      onRetry={() => void query.refetch()}
    >
      <UserMenu logoutOnly />
    </ErrorState>
  )
  return (
    <CabinetLayout
      navigation={studentNavigation}
      student
      home="/schedule"
      initials={getStudentInitials(query.data.full_name)}
    >
      <AccessRecovery blocked={query.isError} fallback={failure}>
        <PasswordSettingsForm />
      </AccessRecovery>
    </CabinetLayout>
  )
}

function PasswordSettingsForm() {
  const { finishPasswordChange } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [visible, setVisible] = useState({ current: false, next: false, confirm: false })
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState({ current: '', next: '', confirm: '' })
  const [uncertain, setUncertain] = useState(false)
  const inFlight = useRef(false)
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const focusErrorRef = useRef<keyof typeof errors | null>(null)

  function reportErrors(nextErrors: typeof errors) {
    setErrors(nextErrors)
    focusErrorRef.current = nextErrors.current
      ? 'current'
      : nextErrors.next
        ? 'next'
        : nextErrors.confirm
          ? 'confirm'
          : null
  }

  useEffect(() => {
    const field = focusErrorRef.current
    focusErrorRef.current = null
    if (field === 'current') currentRef.current?.focus()
    else if (field === 'next') nextRef.current?.focus()
    else if (field === 'confirm') confirmRef.current?.focus()
  }, [errors])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setErrors({ current: '', next: '', confirm: '' })
    if (!currentPassword) {
      reportErrors({ current: 'Введите действующий пароль.', next: '', confirm: '' })
      return
    }
    const length = Array.from(newPassword).length
    if (length < 12 || length > 128) {
      reportErrors({
        current: '',
        next: 'Новый пароль должен содержать от 12 до 128 Unicode-символов.',
        confirm: '',
      })
      return
    }
    if (!confirmPassword || newPassword !== confirmPassword) {
      reportErrors({
        current: '',
        next: '',
        confirm: confirmPassword ? 'Пароли не совпадают.' : 'Повторите новый пароль.',
      })
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      await apiFetch<void>('/api/v1/auth/password', {
        method: 'POST',
        authenticated: true,
        replayAfterRefresh: false,
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          confirm_password: confirmPassword,
        }),
      })
      await finishPasswordChange()
      navigate('/login', { replace: true })
    } catch (requestError) {
      if (
        requestError instanceof ApiClientError &&
        requestError.status === 401 &&
        requestError.code === 'invalid_credentials'
      ) {
        reportErrors({ current: 'Действующий пароль неверен.', next: '', confirm: '' })
      } else if (requestError instanceof ApiClientError && requestError.status === 401) {
        await finishPasswordChange(true)
        navigate('/login', { replace: true })
      } else if (
        requestError instanceof ApiClientError &&
        requestError.code === 'password_unchanged'
      ) {
        reportErrors({
          current: '',
          next: 'Новый пароль должен отличаться от действующего.',
          confirm: '',
        })
      } else if (requestError instanceof ApiClientError && requestError.status === 422) {
        reportErrors({
          current: '',
          next: 'Проверьте новый пароль.',
          confirm: 'Проверьте подтверждение.',
        })
      } else {
        setUncertain(true)
        await finishPasswordChange(true)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (uncertain)
    return (
      <section className="section-page password-settings" aria-labelledby="password-title">
        <h1 id="password-title">Проверьте вход</h1>
        <p role="alert">
          Ответ сервера не получен. Пароль мог измениться, поэтому запрос не повторялся.
        </p>
        <button onClick={() => navigate('/login', { replace: true })}>Перейти ко входу</button>
      </section>
    )

  return (
    <section className="section-page password-settings" aria-labelledby="password-title">
      <h1 id="password-title">Настройки</h1>
      <h2>Смена пароля</h2>
      <p>После смены пароля все устройства выйдут из аккаунта. Затем войдите с новым паролем.</p>
      <p>Новый пароль: от 12 до 128 Unicode-символов. Пробелы и символы Unicode разрешены.</p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="password-field">
          <label htmlFor="current-password">Действующий пароль</label>
          <input
            id="current-password"
            ref={currentRef}
            type={visible.current ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              if (Array.from(event.target.value).length <= 1024) {
                setCurrentPassword(event.target.value)
                setErrors((value) => ({ ...value, current: '' }))
              } else {
                reportErrors({
                  current: 'Действующий пароль не может быть длиннее 1024 символов.',
                  next: '',
                  confirm: '',
                })
              }
            }}
            required
            disabled={busy}
            aria-invalid={Boolean(errors.current)}
            aria-describedby={errors.current ? 'current-password-error' : undefined}
          />
          <button
            type="button"
            onClick={() => setVisible((value) => ({ ...value, current: !value.current }))}
            aria-label={
              visible.current ? 'Скрыть действующий пароль' : 'Показать действующий пароль'
            }
            disabled={busy}
          >
            {visible.current ? 'Скрыть' : 'Показать'}
          </button>
          {errors.current && (
            <span id="current-password-error" role="alert">
              {errors.current}
            </span>
          )}
        </div>
        <div className="password-field">
          <label htmlFor="new-password">Новый пароль</label>
          <input
            id="new-password"
            ref={nextRef}
            type={visible.next ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(Array.from(event.target.value).slice(0, 129).join(''))
              setErrors((value) => ({ ...value, next: '', confirm: '' }))
            }}
            required
            disabled={busy}
            aria-invalid={Boolean(errors.next)}
            aria-describedby={errors.next ? 'new-password-error' : undefined}
          />
          <button
            type="button"
            onClick={() => setVisible((value) => ({ ...value, next: !value.next }))}
            aria-label={visible.next ? 'Скрыть новый пароль' : 'Показать новый пароль'}
            disabled={busy}
          >
            {visible.next ? 'Скрыть' : 'Показать'}
          </button>
          {errors.next && (
            <span id="new-password-error" role="alert">
              {errors.next}
            </span>
          )}
        </div>
        <div className="password-field">
          <label htmlFor="confirm-password">Повторите новый пароль</label>
          <input
            id="confirm-password"
            ref={confirmRef}
            type={visible.confirm ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(Array.from(event.target.value).slice(0, 129).join(''))
              setErrors((value) => ({ ...value, confirm: '' }))
            }}
            required
            disabled={busy}
            aria-invalid={Boolean(errors.confirm)}
            aria-describedby={errors.confirm ? 'confirm-password-error' : undefined}
          />
          <button
            type="button"
            onClick={() => setVisible((value) => ({ ...value, confirm: !value.confirm }))}
            aria-label={
              visible.confirm ? 'Скрыть подтверждение пароля' : 'Показать подтверждение пароля'
            }
            disabled={busy}
          >
            {visible.confirm ? 'Скрыть' : 'Показать'}
          </button>
          {errors.confirm && (
            <span id="confirm-password-error" role="alert">
              {errors.confirm}
            </span>
          )}
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сменить пароль'}
        </button>
      </form>
    </section>
  )
}
