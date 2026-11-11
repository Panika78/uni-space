import { useEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

type Service = components['schemas']['Service']
type Application = components['schemas']['ApplicationResponse']
type CreateApplicationRequest = components['schemas']['CreateApplicationRequest']

const isPythonWhitespace = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0
  return (
    (codePoint >= 9 && codePoint <= 13) ||
    (codePoint >= 28 && codePoint <= 32) ||
    codePoint === 133 ||
    codePoint === 160 ||
    codePoint === 5760 ||
    (codePoint >= 8192 && codePoint <= 8202) ||
    codePoint === 8232 ||
    codePoint === 8233 ||
    codePoint === 8239 ||
    codePoint === 8287 ||
    codePoint === 12288
  )
}

const trimPythonWhitespace = (text: string) => {
  const characters = Array.from(text)
  let start = 0
  let end = characters.length
  while (start < end && isPythonWhitespace(characters[start])) start += 1
  while (end > start && isPythonWhitespace(characters[end - 1])) end -= 1
  return characters.slice(start, end).join('')
}

export function ServicesPage() {
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    apiFetch<components['schemas']['ServiceList']>('/api/v1/services', {
      authenticated: true,
    }).then(
      (data) => {
        if (active) setServices(data.items)
      },
      () => {
        if (active) setError(true)
      },
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <section className="section-page service-page">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1>Услуги и документы</h1>
      <p>Выберите доступную услугу.</p>
      {error ? (
        <div role="alert">
          <p>Не удалось загрузить каталог.</p>
          <button onClick={() => location.reload()}>Повторить загрузку</button>
        </div>
      ) : services === null ? (
        <p role="status">Загружаем каталог…</p>
      ) : services.length === 0 ? (
        <p>Сейчас нет доступных услуг.</p>
      ) : (
        <div className="service-card">
          <div>
            <span aria-hidden="true">▤</span>
            <h2>{services[0].title}</h2>
            <p>Подайте заявление на получение справки об обучении.</p>
          </div>
          <Link className="service-action" to={`/services/${services[0].code}`}>
            Подать заявление
          </Link>
        </div>
      )}
    </section>
  )
}

export function ApplicationFormPage() {
  const navigate = useNavigate()
  const { serviceCode } = useParams()
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [application, setApplication] = useState<Application | null>(null)
  const [error, setError] = useState('')
  const [serverFieldError, setServerFieldError] = useState<string | null>(null)
  const { setHasUnsavedChanges: setUnsavedChanges } = useUnsavedChanges()
  const input = useRef<HTMLTextAreaElement>(null)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false)
  const dirty = value.length > 0 && !application
  const blocker = useBlocker(dirty && !pending && !application)
  useEffect(() => {
    setUnsavedChanges(dirty)
    return () => setUnsavedChanges(false)
  }, [dirty, setUnsavedChanges])
  useEffect(() => {
    if (serverFieldError && !pending) input.current?.focus()
  }, [pending, serverFieldError])
  useEffect(() => {
    const dialog = leaveDialog.current
    if (blocker.state === 'blocked') {
      if (!dialog?.open) dialog?.showModal()
      continueButton.current?.focus()
    } else if (dialog?.open) {
      dialog.close()
    }
  }, [blocker.state])
  useEffect(() => {
    if (!dirty) return
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [dirty])
  const normalized = trimPythonWhitespace(value)
  const characterCount = Array.from(normalized).length
  const invalid = characterCount < 1 || characterCount > 300
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    setError('')
    setServerFieldError(null)
    if (invalid) {
      input.current?.focus()
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    try {
      const result = await apiFetch<Application>('/api/v1/applications', {
        method: 'POST',
        authenticated: true,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          service_code: 'study_certificate',
          form_data: { place_of_submission: normalized },
        } satisfies CreateApplicationRequest),
      })
      setApplication(result)
    } catch (cause) {
      const fieldError =
        cause instanceof ApiClientError
          ? cause.details.find(
              (detail) =>
                detail.field === 'form_data.place_of_submission' ||
                detail.field === 'place_of_submission',
            )
          : undefined
      if (fieldError) {
        setServerFieldError(
          fieldError.code === 'required'
            ? 'Заполните обязательное поле.'
            : 'Проверьте значение: от 1 до 300 символов.',
        )
        setTouched(true)
        return
      }
      const uncertain =
        !(cause instanceof ApiClientError) || cause.status === undefined || cause.status >= 500
      setError(
        uncertain
          ? 'Не удалось получить подтверждение. Заявление могло сохраниться; система не отправляла запрос повторно.'
          : 'Не удалось создать заявление. Проверьте данные и попробуйте позже.',
      )
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  const fieldMessage =
    serverFieldError ??
    (invalid ? 'Введите от 1 до 300 символов после удаления пробелов по краям.' : null)
  const hasFieldError = Boolean(serverFieldError || (touched && invalid))
  if (serviceCode !== 'study_certificate') {
    return (
      <section className="section-page service-page" role="alert">
        <h1>Услуга недоступна</h1>
        <Link className="service-back" to="/services">
          Вернуться к каталогу
        </Link>
      </section>
    )
  }
  return (
    <section className="section-page service-page">
      <Link to="/services" className="service-back">
        ← К каталогу услуг
      </Link>
      <p className="section-eyebrow">Заявление</p>
      <h1>Справка об обучении</h1>
      {application ? (
        <div className="application-success" role="status">
          <h2>Заявление создано</h2>
          <p>
            Номер заявления: <strong>№ {application.id}</strong>
          </p>
          <p>Заявление сохранено. Информация о дальнейшей обработке появится позже.</p>
          <button className="service-action" onClick={() => navigate('/services')}>
            Вернуться к каталогу
          </button>
        </div>
      ) : (
        <form className="application-form" onSubmit={handleSubmit} noValidate>
          <p>Укажите место предоставления справки.</p>
          <label htmlFor="place">
            Место предоставления <span aria-hidden="true">*</span>
          </label>
          <textarea
            ref={input}
            id="place"
            name="place_of_submission"
            rows={3}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setServerFieldError(null)
            }}
            onBlur={() => setTouched(true)}
            required
            aria-required="true"
            aria-invalid={hasFieldError}
            aria-describedby={hasFieldError ? 'place-error' : 'place-help'}
            disabled={pending}
          />
          <small id={hasFieldError ? 'place-error' : 'place-help'}>
            {fieldMessage ?? 'От 1 до 300 символов.'}
          </small>
          <small>Знак * обозначает обязательное поле.</small>
          {error && (
            <p role="alert" className="application-error">
              {error}
            </p>
          )}
          <button className="service-action" type="submit" disabled={pending}>
            {pending ? 'Отправляем…' : 'Отправить заявление'}
          </button>
        </form>
      )}
      {blocker.state === 'blocked' && (
        <dialog
          ref={leaveDialog}
          className="unsaved-dialog"
          aria-labelledby="unsaved-dialog-title"
          onCancel={(event) => {
            event.preventDefault()
            blocker.reset()
          }}
        >
          <h2 id="unsaved-dialog-title">Выйти без сохранения?</h2>
          <p>Введённые данные будут потеряны.</p>
          <div className="unsaved-dialog__actions">
            <button ref={continueButton} type="button" onClick={() => blocker.reset()}>
              Продолжить заполнение
            </button>
            <button type="button" onClick={() => blocker.proceed()}>
              Выйти
            </button>
          </div>
        </dialog>
      )}
    </section>
  )
}
