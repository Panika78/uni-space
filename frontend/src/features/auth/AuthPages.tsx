import { useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { LoadingState } from '../../shared/ui/StatusStates'
import { BrandMark } from '../../shared/ui/UniversityBrand'

export function ProtectedRoute() {
  const { status } = useAuth()
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />
  return status === 'authenticated' ? <Outlet /> : <Navigate to="/login" replace />
}

export function LoginPage() {
  const { status, message, busy, login } = useAuth()
  const [password, setPassword] = useState('')
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />
  if (status === 'authenticated') return <Navigate to="/schedule" replace />
  return (
    <section className="welcome-card login-card" aria-labelledby="login-title">
      <div className="login-brand">
        <BrandMark />
        <p>РГУЧВ им. А. М. Кашпировского</p>
      </div>
      <h1 id="login-title">Вход в систему</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          const data = new FormData(event.currentTarget)
          void login({ login: String(data.get('login')), password }).then((success) => {
            if (success) setPassword('')
          })
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
        {message && <p role="status">{message}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Подождите…' : 'Войти'}
        </button>
      </form>
    </section>
  )
}
