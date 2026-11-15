import { useAccessSuspended } from '../../shared/ui/AccessRecovery'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApplicationsList, applicationsKey, ServicesTabs } from './ApplicationsPages'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useBlocker, useParams, useSearchParams } from 'react-router-dom'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { Icon } from '../../shared/ui/Icon'
import { AnimatedRegion } from '../../shared/ui/AnimatedRegion'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'

type Application = components['schemas']['ApplicationResponse']
type CreateApplicationRequest =
  | components['schemas']['CreateStudyCertificateRequest']
  | components['schemas']['CreateAcademicTranscriptRequest']
  | components['schemas']['CreateAcademicLeaveRequest']
  | components['schemas']['CreateAccountingCertificateRequest']

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
  const query = useQuery({
    queryKey: ['services'],
    queryFn: ({ signal }) =>
      apiFetch<components['schemas']['ServiceList']>('/api/v1/services', {
        authenticated: true,
        signal,
      }),
    refetchOnMount: 'always',
    retryOnMount: true,
  })
  const services = query.data?.items ?? []
  const isDenied = query.error instanceof ApiClientError && query.error.status === 403
  return (
    <div className="service-catalog-page">
      <p>Выберите доступную услугу.</p>
      {isDenied ? (
        <ErrorState
          title="Доступ к каталогу услуг запрещён"
          description="У вас нет доступа к каталогу услуг. Обратитесь к администратору."
        />
      ) : query.isPending || (query.isFetching && query.isError) ? (
        <LoadingState title="Загружаем каталог…" />
      ) : query.isError ? (
        <ErrorState
          title="Не удалось загрузить каталог"
          description="Проверьте соединение и повторите попытку."
          onRetry={() => void query.refetch()}
        />
      ) : services.length === 0 ? (
        <EmptyState title="Сейчас нет доступных услуг." />
      ) : (
        <div className="service-catalog-grid">
          {services.map((service) => (
            <article className="service-card" key={service.code} aria-label={service.title}>
              <div className="service-card__icon-box" aria-hidden="true">
                <Icon name="file" />
              </div>
              <span className="service-card__divider" aria-hidden="true" />
              <div className="service-card__content">
                <h2>{service.title}</h2>
                <p>{service.description ?? ''}</p>
                <ul className="service-card__badges">
                  <li>Онлайн</li>
                  <li>
                    {service.processing_mode === 'manual'
                      ? 'Рассмотрение сотрудником'
                      : 'Автоматическая'}
                  </li>
                  {service.produces_document !== false && <li>Документ</li>}
                </ul>
                {service.action_available === false && (
                  <p className="service-unavailable">{service.unavailable_reason}</p>
                )}
              </div>
              {service.action_available === true ? (
                <Link className="service-action" to={`/services/${service.code}`}>
                  Подать заявление <Icon name="arrow" />
                </Link>
              ) : (
                <button className="service-action" type="button" disabled>
                  Пока недоступно
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

export function ApplicationFormPage() {
  const { serviceCode } = useParams()
  if (serviceCode && serviceCode !== 'study_certificate') {
    return <AdditionalApplicationFormPage serviceCode={serviceCode} />
  }
  return <StudyCertificateFormPage />
}

function AdditionalApplicationFormPage({ serviceCode }: { serviceCode: string }) {
  const servicesQuery = useQuery({
    queryKey: ['services'],
    queryFn: ({ signal }) =>
      apiFetch<components['schemas']['ServiceList']>('/api/v1/services', {
        authenticated: true,
        signal,
      }),
    refetchOnMount: 'always',
  })
  const service = servicesQuery.data?.items.find((item) => item.code === serviceCode)
  const isLeave = serviceCode === 'academic_leave'
  const isTranscript = serviceCode === 'academic_transcript'
  const isAccounting = serviceCode === 'accounting_certificate'
  const title =
    service?.title ??
    (isTranscript
      ? 'Выписка об успеваемости'
      : isLeave
        ? 'Академический отпуск'
        : 'Бухгалтерская справка')
  const [basis, setBasis] = useState<'medical' | 'family' | 'other'>('medical')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [explanation, setExplanation] = useState('')
  const [purpose, setPurpose] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const queryClient = useQueryClient()
  const startsOnInput = useRef<HTMLInputElement>(null)
  const endsOnInput = useRef<HTMLInputElement>(null)
  const explanationInput = useRef<HTMLTextAreaElement>(null)
  const { setStatus: setExitStatus } = useUnsavedChanges()
  const draft =
    !applicationId &&
    !uncertain &&
    (isLeave ? Boolean(startsOn || endsOn || explanation) : isAccounting && Boolean(purpose))
  const blocker = useBlocker(draft || pending)
  useEffect(() => {
    setExitStatus(
      applicationId
        ? 'none'
        : pending
          ? 'submitting'
          : uncertain
            ? 'uncertain'
            : draft
              ? 'draft'
              : 'none',
    )
    return () => setExitStatus('none')
  }, [applicationId, draft, pending, setExitStatus, uncertain])
  const invalidDates = isLeave && (!startsOn || !endsOn || startsOn > endsOn)
  const invalidExplanation = isLeave && basis === 'other' && explanation.trim().length === 0
  const invalid = invalidDates || invalidExplanation
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    setError('')
    if (invalid) {
      if (isLeave && !startsOn) startsOnInput.current?.focus()
      else if (isLeave && (!endsOn || startsOn > endsOn)) endsOnInput.current?.focus()
      else explanationInput.current?.focus()
      return
    }
    if (service?.action_available !== true || pending || uncertain) return
    setPending(true)
    try {
      const formData = isTranscript
        ? {}
        : isAccounting
          ? { purpose: purpose.trim() || null }
          : {
              basis,
              starts_on: startsOn,
              ends_on: endsOn,
              explanation: basis === 'other' ? explanation.trim() : null,
            }
      const result = await apiFetch<unknown>('/api/v1/applications', {
        method: 'POST',
        authenticated: true,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ service_code: serviceCode, form_data: formData }),
      })
      const response = result as Application
      if (
        !response ||
        typeof response !== 'object' ||
        !response.service ||
        response.service.code !== serviceCode ||
        response.review_status !== 'submitted' ||
        response.document_status !== (isLeave ? 'not_required' : 'pending')
      ) {
        throw new ApiClientError(
          'Сервер вернул некорректное подтверждение',
          'invalid_response',
          201,
        )
      }
      setApplicationId(response.id)
      queryClient.removeQueries({ queryKey: applicationsKey })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      const isUncertain =
        !(cause instanceof ApiClientError) ||
        cause.status === undefined ||
        cause.status >= 500 ||
        cause.code === 'invalid_response'
      setUncertain(isUncertain)
      setError(
        isUncertain
          ? 'Ответ не получен. Заявление могло сохраниться; проверьте список заявлений перед повтором.'
          : 'Не удалось создать заявление. Проверьте данные и попробуйте ещё раз.',
      )
    } finally {
      setPending(false)
    }
  }
  if (!['academic_transcript', 'academic_leave', 'accounting_certificate'].includes(serviceCode)) {
    return (
      <section className="section-page service-page">
        <h1>Услуга недоступна</h1>
        <Link to="/services">Вернуться к каталогу</Link>
      </section>
    )
  }
  return (
    <section className="section-page service-page">
      <Link to="/services" className="service-back">
        <Icon name="left" /> К каталогу услуг
      </Link>
      <p className="section-eyebrow">Новое заявление</p>
      <h1>{applicationId ? 'Заявление создано' : title}</h1>
      {applicationId ? (
        <div className="application-success" role="status">
          <h2>Заявление № {applicationId}</h2>
          <p>Сервер подтвердил сохранение заявления.</p>
          <Link className="service-action" to={`/applications/${applicationId}`}>
            Открыть заявление
          </Link>
        </div>
      ) : (
        <form className="application-form" onSubmit={handleSubmit} noValidate>
          <h2>Данные заявления</h2>
          <p>* — обязательные поля</p>
          {isTranscript && (
            <p>
              Текущий учебный период будет выбран сервером автоматически. Выбор периода не
              требуется.
            </p>
          )}
          {isLeave && (
            <>
              <label htmlFor="leave-basis">
                Основание <span aria-hidden="true">*</span>
              </label>
              <select
                id="leave-basis"
                value={basis}
                onChange={(event) => setBasis(event.target.value as typeof basis)}
              >
                <option value="medical">Медицинское</option>
                <option value="family">Семейные обстоятельства</option>
                <option value="other">Иное</option>
              </select>
              <label htmlFor="leave-start">
                Дата начала <span aria-hidden="true">*</span>
              </label>
              <input
                ref={startsOnInput}
                id="leave-start"
                type="date"
                value={startsOn}
                onChange={(event) => setStartsOn(event.target.value)}
                aria-invalid={touched && !startsOn}
                aria-describedby={touched && !startsOn ? 'leave-start-error' : undefined}
              />
              {touched && !startsOn && (
                <small id="leave-start-error" role="alert">
                  Укажите дату начала.
                </small>
              )}
              <label htmlFor="leave-end">
                Дата окончания <span aria-hidden="true">*</span>
              </label>
              <input
                ref={endsOnInput}
                id="leave-end"
                type="date"
                value={endsOn}
                onChange={(event) => setEndsOn(event.target.value)}
                aria-invalid={touched && (!endsOn || startsOn > endsOn)}
                aria-describedby={
                  touched && (!endsOn || startsOn > endsOn) ? 'leave-end-error' : undefined
                }
              />
              {touched && (!endsOn || startsOn > endsOn) && (
                <small id="leave-end-error" role="alert">
                  {startsOn > endsOn
                    ? 'Окончание должно быть не раньше начала.'
                    : 'Укажите дату окончания.'}
                </small>
              )}
              {basis === 'other' && (
                <>
                  <label htmlFor="leave-explanation">
                    Пояснение <span aria-hidden="true">*</span>
                  </label>
                  <textarea
                    ref={explanationInput}
                    id="leave-explanation"
                    value={explanation}
                    onChange={(event) => setExplanation(event.target.value)}
                    aria-invalid={touched && !explanation.trim()}
                    aria-describedby={
                      touched && !explanation.trim() ? 'leave-explanation-error' : undefined
                    }
                  />
                  {touched && !explanation.trim() && (
                    <small id="leave-explanation-error" role="alert">
                      Добавьте пояснение.
                    </small>
                  )}
                </>
              )}
              <div className="attachment-requirement">
                <strong>Подтверждение обязательно</strong>
                <p>
                  {basis === 'medical'
                    ? 'Медицинская справка или заключение.'
                    : basis === 'family'
                      ? 'Документ, подтверждающий семейные обстоятельства.'
                      : 'Документ, подтверждающий указанное обстоятельство.'}
                </p>
                <p>
                  Функция прикрепления файлов будет доступна после подключения защищённого
                  хранилища.
                </p>
              </div>
            </>
          )}
          {isAccounting && (
            <>
              <label htmlFor="accounting-purpose">Цель получения (необязательно)</label>
              <input
                id="accounting-purpose"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                maxLength={300}
              />
            </>
          )}
          {touched && invalid && <p role="alert">Проверьте обязательные поля и даты.</p>}
          {error && (
            <p role="alert" className="application-error">
              {error}
            </p>
          )}
          {uncertain && (
            <Link to="/services?tab=applications">Проверить результат в моих заявлениях</Link>
          )}
          <div className="form-actions">
            <button
              className="service-action"
              type="submit"
              disabled={
                service?.action_available !== true ||
                pending ||
                uncertain ||
                Boolean(servicesQuery.isPending)
              }
            >
              {pending
                ? 'Отправляем…'
                : service?.action_available !== true
                  ? 'Подача пока недоступна'
                  : 'Отправить заявление'}{' '}
              <Icon name="arrow" />
            </button>
            <Link className="service-action service-action--light" to="/services">
              Отмена
            </Link>
          </div>
        </form>
      )}
      {blocker.state === 'blocked' && (
        <div className="unsaved-dialog-backdrop" role="presentation">
          <section
            className="unsaved-dialog"
            role="alertdialog"
            aria-labelledby="additional-unsaved-title"
            aria-modal="true"
          >
            <h2 id="additional-unsaved-title">
              {pending ? 'Запрос уже отправлен. Покинуть форму?' : 'Выйти без сохранения?'}
            </h2>
            <p>
              {pending
                ? 'Заявление может сохраниться; проверьте его в списке заявлений.'
                : 'Введённые данные ещё не отправлены и будут потеряны.'}
            </p>
            <div className="unsaved-dialog__actions">
              <button type="button" onClick={() => blocker.reset()}>
                Продолжить заполнение
              </button>
              <button type="button" onClick={() => blocker.proceed()}>
                {pending ? 'Покинуть форму' : 'Выйти'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

function StudyCertificateFormPage() {
  const isSuspended = useAccessSuspended()
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
  const checkResult = useRef<HTMLAnchorElement>(null)
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
    if (serverFieldError && !pending && !isSuspended) input.current?.focus()
  }, [pending, serverFieldError, isSuspended])
  useLayoutEffect(() => {
    const dialog = leaveDialog.current
    if (blocker.state === 'blocked' && !isSuspended) {
      if (!dialog?.open) dialog?.showModal()
      continueButton.current?.focus()
    } else if (dialog?.open) {
      dialog.close()
    }
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [blocker.state, isSuspended])
  useEffect(() => {
    if (exitStatus === 'none') return
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [exitStatus])
  useEffect(() => {
    if (uncertain && !isSuspended) checkResult.current?.focus({ preventScroll: true })
  }, [uncertain, isSuspended])
  const normalized = trimPythonWhitespace(value)
  const characterCount = Array.from(normalized).length
  const invalid = characterCount < 1 || characterCount > 300
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSuspended || uncertain || inFlight.current) return
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
    (touched && invalid ? 'Введите от 1 до 300 символов после удаления пробелов по краям.' : null)
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
        <Icon name="left" /> К каталогу услуг
      </Link>
      <p className="section-eyebrow">{application ? 'Услуги и документы' : 'Новое заявление'}</p>
      <h1>{application ? 'Заявление создано' : 'Справка об обучении'}</h1>
      <p className="service-subtitle">
        {application
          ? 'Заявление сохранено.'
          : 'Заполните короткую форму — это займёт меньше минуты'}
      </p>
      {application ? (
        <div className="application-success" role="status">
          <span className="success-mark" aria-hidden="true">
            <Icon name="check" />
          </span>
          <h2>
            Готово! Заявление <span>№ {application.id}</span>
          </h2>
          <p>Вы можете посмотреть детали заявления или вернуться в каталог услуг.</p>
          <div className="form-actions">
            <Link className="service-action" to={`/applications/${application.id}`}>
              Открыть заявление
            </Link>
            <Link className="service-action service-action--light" to="/services?tab=applications">
              Мои заявления
            </Link>
          </div>
        </div>
      ) : (
        <form className="application-form" onSubmit={handleSubmit} noValidate>
          <div className="service-card-heading">
            <span className="service-icon-small" aria-hidden="true">
              <Icon name="file" />
            </span>
            <div>
              <h2>Данные заявления</h2>
              <p>Знак * обозначает обязательное поле.</p>
            </div>
          </div>
          <label htmlFor="place">
            Место предоставления <span aria-hidden="true">*</span>
          </label>
          <textarea
            ref={input}
            id="place"
            name="place_of_submission"
            rows={3}
            placeholder="Например, для предоставления по месту требования"
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
            disabled={pending || uncertain}
          />
          <div className="application-field-help">
            <small id={hasFieldError ? 'place-error' : 'place-help'}>
              {fieldMessage ?? 'От 1 до 300 символов.'}
            </small>
            <small className="application-character-count" aria-live="off">
              {characterCount} / 300
            </small>
          </div>
          {error && (
            <p role="alert" className="application-error">
              {error}
            </p>
          )}
          {uncertain && (
            <Link ref={checkResult} to="/services?tab=applications">
              Проверить результат в моих заявлениях
            </Link>
          )}
          <div className="form-actions">
            <button className="service-action" type="submit" disabled={pending || uncertain}>
              {pending ? 'Отправляем…' : 'Отправить заявление'} <Icon name="arrow" />
            </button>
            <Link className="service-action service-action--light" to="/services">
              Отмена
            </Link>
          </div>
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
