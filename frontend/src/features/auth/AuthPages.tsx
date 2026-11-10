import { useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { LoadingState, UnavailableState } from '../../shared/ui/StatusStates'

export function ProtectedRoute() {
  const { status } = useAuth()
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />
  return status === 'authenticated' ? <Outlet /> : <Navigate to="/login" replace />
}

export function LoginPage() {
  const { status, message, busy, canRetryLogout, login, logout } = useAuth()
  const [password, setPassword] = useState('')
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />
  if (status === 'authenticated') return <Navigate to="/schedule" replace />
  return (
    <section className="welcome-card login-card" aria-labelledby="login-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="login-title">Вход</h1>
      {message && <p role="status">{message}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          const data = new FormData(event.currentTarget)
          void login({ login: String(data.get('login')), password })
          setPassword('')
        }}
      >
        <label>
          Логин
          <input name="login" autoComplete="username" required maxLength={256} disabled={busy} />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Подождите…' : 'Войти'}
        </button>
      </form>
      {canRetryLogout && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void logout()
          }}
        >
          Повторить выход
        </button>
      )}
    </section>
  )
}

export function SchedulePage() {
  return (
    <section className="section-page" aria-labelledby="schedule-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="schedule-title">Расписание</h1>
      <UnavailableState
        title="Расписание пока недоступно"
        description="Содержимое расписания появится в следующих задачах."
      />
    </section>
  )
}
