import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { useAuth } from './AuthProvider'
import './passwordSettings.css'

export function PasswordSettingsPage() {
  const { finishPasswordChange } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const inFlight = useRef(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setError('')
    const length = Array.from(newPassword).length
    if (length < 12 || length > 128) {
      setError('Новый пароль должен содержать от 12 до 128 Unicode-символов.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Пароли не совпадают.')
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
      if (requestError instanceof ApiClientError && requestError.status === 401) {
        setError('Действующий пароль неверен.')
      } else if (
        requestError instanceof ApiClientError &&
        requestError.code === 'password_unchanged'
      ) {
        setError('Новый пароль должен отличаться от действующего.')
      } else if (requestError instanceof ApiClientError && requestError.status === 422) {
        setError('Проверьте длину и подтверждение нового пароля.')
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
      <h1 id="password-title">Смена пароля</h1>
      <p>После смены пароля все устройства выйдут из аккаунта. Затем войдите с новым паролем.</p>
      <p>Новый пароль: от 12 до 128 Unicode-символов. Пробелы и символы Unicode разрешены.</p>
      <form onSubmit={handleSubmit} noValidate>
        <label>
          Действующий пароль
          <input
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              if (Array.from(event.target.value).length <= 1024)
                setCurrentPassword(event.target.value)
              else setError('Действующий пароль не может быть длиннее 1024 символов.')
            }}
            required
            disabled={busy}
          />
        </label>
        <label>
          Новый пароль
          <input
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              if (Array.from(event.target.value).length <= 128) setNewPassword(event.target.value)
              else setError('Новый пароль не может быть длиннее 128 Unicode-символов.')
            }}
            required
            disabled={busy}
          />
        </label>
        <label>
          Повторите новый пароль
          <input
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              if (Array.from(event.target.value).length <= 128)
                setConfirmPassword(event.target.value)
              else setError('Подтверждение не может быть длиннее 128 Unicode-символов.')
            }}
            required
            disabled={busy}
          />
        </label>
        <label className="password-visibility">
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setVisible(event.target.checked)}
            disabled={busy}
          />
          Показать пароль
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          type="submit"
          disabled={busy || !currentPassword || !newPassword || !confirmPassword}
        >
          {busy ? 'Сохраняем…' : 'Сменить пароль'}
        </button>
      </form>
    </section>
  )
}
