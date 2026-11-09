import { useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export function ProtectedRoute() {
  const { status } = useAuth()
  if (status === 'initializing') return <p role="status">Проверяем сессию…</p>
  return status === 'authenticated' ? <Outlet /> : <Navigate to="/login" replace />
}

export function LoginPage() {
  const { status, message, busy, login, logout } = useAuth()
  const [password, setPassword] = useState('')
  if (status === 'initializing') return <p role="status">Проверяем сессию…</p>
  if (status === 'authenticated') return <Navigate to="/schedule" replace />
  return (
    <section className="welcome-card">
      <h1>Вход</h1>
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
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void logout()
        }}
      >
        Повторить выход
      </button>
    </section>
  )
}

export function SchedulePage() {
  const { logout } = useAuth()
  return (
    <section className="welcome-card">
      <h1>Расписание</h1>
      <p>Вход выполнен. Расписание появится на следующем этапе.</p>
      <button
        onClick={() => {
          void logout()
        }}
      >
        Выйти
      </button>
    </section>
  )
}
