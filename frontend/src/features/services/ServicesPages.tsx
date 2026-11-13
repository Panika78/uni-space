import { useQueryClient } from '@tanstack/react-query'
import { ApplicationsList, applicationsKey, ServicesTabs } from './ApplicationsPages'
import { useEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { AnimatedRegion } from '../../shared/ui/AnimatedRegion'

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

function isApplicationResponse(value: unknown, placeOfSubmission: string): value is Application {
  if (typeof value !== 'object' || value === null) return false
  const application = value as Record<string, unknown>
  const service = application.service
  const formData = application.form_data
  const isId = (id: unknown) => typeof id === 'string' && /^[1-9][0-9]*$/.test(id)
  const isDateTime = (dateTime: unknown) =>
    typeof dateTime === 'string' && !Number.isNaN(Date.parse(dateTime))

  if (typeof service !== 'object' || service === null) return false
  if (typeof formData !== 'object' || formData === null) return false
  const serviceResponse = service as Record<string, unknown>
  const formDataResponse = formData as Record<string, unknown>

  return (
    isId(application.id) &&
    isId(serviceResponse.id) &&
    serviceResponse.code === 'study_certificate' &&
    typeof serviceResponse.title === 'string' &&
    formDataResponse.place_of_submission === placeOfSubmission &&
    application.review_status === 'submitted' &&
    application.document_status === 'pending' &&
    application.feedback === null &&
    isDateTime(application.created_at) &&
    isDateTime(application.updated_at)
  )
}

export function ServicesPage() {
  const [params] = useSearchParams()
  const applications = params.get('tab') === 'applications'
  return (
    <section className="section-page service-page">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1>Услуги и документы</h1>
      <p className="service-subtitle">Оформление заявлений и отслеживание их статуса</p>
      <ServicesTabs applications={applications} />
      <AnimatedRegion
        className="services-stage"
        contentKey={applications ? 'applications' : 'catalog'}
      >
        {applications ? <ApplicationsList /> : <ServiceCatalog />}
      </AnimatedRegion>
    </section>
  )
}

function ServiceCatalog() {
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
    <div className="service-catalog-page">
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
        <article className="service-card" aria-labelledby="study-certificate-title">
          <div className="service-card__icon-box" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none">
              <path
                d="M19 8.5h18l14 14V54a3.5 3.5 0 0 1-3.5 3.5h-28A3.5 3.5 0 0 1 16 54V12a3.5 3.5 0 0 1 3-3.5Z"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinejoin="round"
              />
              <path
                d="M37 9v14h14M24 36h18M24 45h18"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="service-card__divider" aria-hidden="true" />
          <div className="service-card__content">
            <h2 id="study-certificate-title">{services[0].title}</h2>
            <p>Подайте заявление на получение справки об обучении.</p>
            <ul className="service-card__badges" aria-label="Характеристики услуги">
              <li>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2.5" y="3.5" width="15" height="11" rx="1.5" />
                  <path d="M1.5 17h17M7 14.5l-.7 2.5m6.7-2.5.7 2.5" />
                </svg>
                Онлайн
              </li>
              <li>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6 2.5h6l5 5v9A1.5 1.5 0 0 1 15.5 18h-9A1.5 1.5 0 0 1 5 16.5v-12A2 2 0 0 1 6 2.5Z" />
                  <path d="M12 2.5v5h5M8 12h5m-5 3h5" />
                </svg>
                Документ
              </li>
            </ul>
          </div>
          <Link className="service-action" to={`/services/${services[0].code}`}>
            Подать заявление
          </Link>
        </article>
      )}
    </div>
  )
}

export function ApplicationFormPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { serviceCode } = useParams()
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [application, setApplication] = useState<Application | null>(null)
  const [error, setError] = useState('')
  const [serverFieldError, setServerFieldError] = useState<string | null>(null)
  const { setStatus: setExitStatus } = useUnsavedChanges()
  const input = useRef<HTMLTextAreaElement>(null)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false)
  const dirty = value.length > 0 && !application
  const exitStatus = application
    ? 'none'
    : pending
      ? 'submitting'
      : uncertain
        ? 'uncertain'
        : dirty
          ? 'draft'
          : 'none'
  const blocker = useBlocker(exitStatus !== 'none')
  useEffect(() => {
    setExitStatus(exitStatus)
  }, [exitStatus, setExitStatus])
  useEffect(() => () => setExitStatus('none'), [setExitStatus])
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
    if (exitStatus === 'none') return
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [exitStatus])
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
      const result = await apiFetch<unknown>('/api/v1/applications', {
        method: 'POST',
        authenticated: true,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          service_code: 'study_certificate',
          form_data: { place_of_submission: normalized },
        } satisfies CreateApplicationRequest),
      })
      if (!isApplicationResponse(result, normalized)) {
        throw new ApiClientError(
          'Сервер вернул некорректное подтверждение',
          'invalid_response',
          201,
        )
      }
      queryClient.removeQueries({ queryKey: applicationsKey })
      setApplication(result)
    } catch (cause) {
      // The shared client aborts requests from an obsolete auth generation.
      if (cause instanceof DOMException && cause.name === 'AbortError') return
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
        !(cause instanceof ApiClientError) ||
        cause.code === 'invalid_response' ||
        cause.status === undefined ||
        cause.status >= 500
      if (uncertain) {
        queryClient.removeQueries({ queryKey: applicationsKey })
        setUncertain(true)
      }
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
          <p>Заявление сохранено.</p>
          <Link className="service-action" to={`/applications/${application.id}`}>
            Открыть заявление
          </Link>
          <Link to="/services?tab=applications">Мои заявления</Link>
          <button className="service-action" onClick={() => navigate('/services')}>
            Вернуться к каталогу
          </button>
        </div>
      ) : (
        <form className="application-form" onSubmit={handleSubmit} noValidate>
          <h2>Данные заявления</h2>
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
          <small className="application-character-count" aria-live="off">
            {characterCount} / 300
          </small>
          {error && (
            <p role="alert" className="application-error">
              {error}
            </p>
          )}
          {uncertain && (
            <Link to="/services?tab=applications">Проверить результат в моих заявлениях</Link>
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
          <h2 id="unsaved-dialog-title">
            {exitStatus === 'submitting'
              ? 'Запрос уже отправлен. Покинуть форму?'
              : exitStatus === 'uncertain'
                ? 'Результат отправки неизвестен. Покинуть форму?'
                : 'Выйти без сохранения?'}
          </h2>
          <p>
            {exitStatus === 'submitting'
              ? 'Заявление может сохраниться; уход не отменит запрос, а подтверждение и номер могут быть потеряны.'
              : exitStatus === 'uncertain'
                ? 'Заявление могло сохраниться, но подтверждение не получено. Повторная отправка не выполняется автоматически.'
                : 'Введённые данные ещё не отправлены и будут потеряны.'}
          </p>
          <div className="unsaved-dialog__actions">
            <button ref={continueButton} type="button" onClick={() => blocker.reset()}>
              Продолжить заполнение
            </button>
            <button type="button" onClick={() => blocker.proceed()}>
              {exitStatus === 'draft' ? 'Выйти' : 'Покинуть форму'}
            </button>
          </div>
        </dialog>
      )}
    </section>
  )
}
