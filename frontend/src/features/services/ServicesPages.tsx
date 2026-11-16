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
  import('../../shared/api/schema').operations['submit_application_api_v1_applications_post']['requestBody']['content']['application/json']

type AdditionalFormField = 'basis' | 'starts_on' | 'ends_on' | 'explanation' | 'purpose'
type AdditionalFormErrors = Partial<Record<AdditionalFormField, string>>

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

function parseRussianDate(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!match) return null
  const [, dayText, monthText, yearText] = match
  const day = Number(dayText),
    month = Number(monthText),
    year = Number(yearText)
  if (year < 1) return null
  const date = new Date(`${yearText}-${monthText}-${dayText}T00:00:00.000Z`)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null
  return `${yearText}-${monthText}-${dayText}`
}

function formatRussianDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : ''
}

function isAdditionalApplicationResponse(
  value: unknown,
  serviceCode: string,
  expectedForm: Record<string, unknown>,
): value is Application {
  if (!value || typeof value !== 'object') return false
  const app = value as Record<string, unknown>
  const service = app.service
  const form = app.form_data
  const isId = (id: unknown) => typeof id === 'string' && /^[1-9][0-9]*$/.test(id)
  const isIsoDate = (date: unknown) => {
    if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date)) return false
    return parseRussianDate(`${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`) !== null
  }
  const isDateTime = (date: unknown) =>
    typeof date === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date) &&
    isIsoDate(date.slice(0, 10)) &&
    !Number.isNaN(Date.parse(date))
  const expectedDocumentStatus = serviceCode === 'academic_leave' ? 'not_required' : 'pending'
  if (!service || typeof service !== 'object' || !form || typeof form !== 'object') return false
  const svc = service as Record<string, unknown>
  const data = form as Record<string, unknown>
  if (
    !isId(app.id) ||
    !Number.isSafeInteger(app.version) ||
    app.version !== 1 ||
    !isDateTime(app.created_at) ||
    !isDateTime(app.updated_at) ||
    app.review_status !== 'submitted' ||
    app.document_status !== expectedDocumentStatus ||
    app.feedback !== null ||
    !isId(svc.id) ||
    svc.code !== serviceCode ||
    typeof svc.title !== 'string' ||
    typeof svc.description !== 'string' ||
    !['automatic', 'manual'].includes(String(svc.processing_mode)) ||
    typeof svc.produces_document !== 'boolean' ||
    !Array.isArray(svc.requirements) ||
    !svc.requirements.every((item) => typeof item === 'string') ||
    typeof svc.action_available !== 'boolean' ||
    !(svc.unavailable_reason === null || typeof svc.unavailable_reason === 'string')
  )
    return false
  const keys = Object.keys(data)
  if (serviceCode === 'academic_transcript') {
    return (
      keys.length === 4 &&
      isId(data.academic_term_id) &&
      typeof data.academic_term_name === 'string' &&
      isIsoDate(data.starts_on) &&
      isIsoDate(data.ends_on) &&
      String(data.starts_on) <= String(data.ends_on)
    )
  }
  return (
    keys.length === Object.keys(expectedForm).length &&
    Object.entries(expectedForm).every(([key, expected]) => data[key] === expected)
  )
}

function getAdditionalFormErrors(
  details: ApiClientError['details'],
): { errors: AdditionalFormErrors; firstField: AdditionalFormField; hasUnmapped: boolean } | null {
  const supportedFields: AdditionalFormField[] = [
    'basis',
    'starts_on',
    'ends_on',
    'explanation',
    'purpose',
  ]
  const errors: AdditionalFormErrors = {}
  let firstField: AdditionalFormField | null = null
  let hasUnmapped = false
  for (const detail of details) {
    const parts = (detail.field ?? '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split(/[./]/)
      .filter(Boolean)
    const formDataIndex = parts.lastIndexOf('form_data')
    const field = formDataIndex === parts.length - 2 ? parts.at(-1) : null
    if (!field || !supportedFields.includes(field as AdditionalFormField)) {
      hasUnmapped = true
      continue
    }
    const mappedField = field as AdditionalFormField
    if (errors[mappedField]) continue
    const messages: Record<AdditionalFormField, string> = {
      basis: detail.code === 'required' ? 'Выберите основание.' : 'Выберите допустимое основание.',
      starts_on:
        detail.code === 'required' ? 'Укажите дату начала.' : 'Введите корректную дату начала.',
      ends_on:
        detail.code === 'required'
          ? 'Укажите дату окончания.'
          : 'Проверьте дату окончания и порядок дат.',
      explanation: detail.code === 'required' ? 'Добавьте пояснение.' : 'Проверьте пояснение.',
      purpose:
        detail.code === 'required' ? 'Проверьте цель получения.' : 'Проверьте цель получения.',
    }
    errors[mappedField] = messages[mappedField]
    firstField ??= mappedField
  }
  return firstField ? { errors, firstField, hasUnmapped } : null
}

function getApplicationErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiClientError)) return 'Не удалось связаться с сервером.'
  const messages: Record<string, string> = {
    academic_term_unavailable: 'Для вашей учебной группы сейчас не настроен учебный период.',
    academic_term_ambiguous: 'Для вашей учебной группы найдено несколько текущих периодов.',
    responsible_unit_unavailable: 'Для факультета не настроено ответственное подразделение.',
    service_unavailable: 'Эта услуга временно недоступна для подачи.',
    validation_error: 'Проверьте заполненные поля и повторите попытку.',
    version_conflict: 'Данные изменились. Обновите список заявлений и проверьте результат.',
    forbidden: 'У вас нет доступа к созданию заявления.',
    invalid_access: 'Сеанс завершён. Войдите в систему заново.',
    session_invalid: 'Сеанс завершён. Войдите в систему заново.',
  }
  if (messages[cause.code]) return messages[cause.code]
  if (cause.status === 401) return 'Сеанс завершён. Войдите в систему заново.'
  if (cause.status === 403) return 'У вас нет доступа к созданию заявления.'
  if (cause.status === 409) return 'Услуга или её настройки сейчас недоступны.'
  if (cause.status === 422) return 'Проверьте заполненные поля и повторите попытку.'
  if (cause.status === 503) return 'Сервис временно недоступен.'
  return 'Не удалось создать заявление. Повторите попытку позже.'
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
                {service.requirements.length > 0 && (
                  <details className="service-requirements">
                    <summary>Требования к услуге</summary>
                    <ul>
                      {service.requirements.map((requirement) => (
                        <li key={requirement}>{requirement}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              {service.action_available === true || service.code === 'academic_leave' ? (
                <Link className="service-action" to={`/services/${service.code}`}>
                  {service.action_available ? 'Подать заявление' : 'Требования и форма'}{' '}
                  <Icon name="arrow" />
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
  const [startsText, setStartsText] = useState('')
  const [endsText, setEndsText] = useState('')
  const startsOn = parseRussianDate(startsText) ?? ''
  const endsOn = parseRussianDate(endsText) ?? ''
  const [explanation, setExplanation] = useState('')
  const [purpose, setPurpose] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [touched, setTouched] = useState(false)
  const [touchedFields, setTouchedFields] = useState({
    startsOn: false,
    endsOn: false,
    explanation: false,
  })
  const [pending, setPending] = useState(false)
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [serverFieldErrors, setServerFieldErrors] = useState<AdditionalFormErrors>({})
  const [firstServerErrorField, setFirstServerErrorField] = useState<AdditionalFormField | null>(
    null,
  )
  const [uncertain, setUncertain] = useState(false)
  const queryClient = useQueryClient()
  const basisInput = useRef<HTMLSelectElement>(null)
  const startsOnInput = useRef<HTMLInputElement>(null)
  const endsOnInput = useRef<HTMLInputElement>(null)
  const explanationInput = useRef<HTMLTextAreaElement>(null)
  const purposeInput = useRef<HTMLInputElement>(null)
  const { setStatus: setExitStatus } = useUnsavedChanges()
  const [initialValues] = useState(() =>
    JSON.stringify({ basis, startsText, endsText, explanation, purpose }),
  )
  const hasChanges =
    JSON.stringify({ basis, startsText, endsText, explanation, purpose }) !== initialValues ||
    selectedFiles.length > 0
  const draft = !applicationId && !uncertain && hasChanges
  const blocker = useBlocker(draft || pending || uncertain)
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draft || pending || uncertain) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [draft, pending, uncertain])
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
  useLayoutEffect(() => {
    if (!firstServerErrorField) return
    const inputs: Record<AdditionalFormField, { current: HTMLElement | null }> = {
      basis: basisInput,
      starts_on: startsOnInput,
      ends_on: endsOnInput,
      explanation: explanationInput,
      purpose: purposeInput,
    }
    inputs[firstServerErrorField].current?.focus()
  }, [firstServerErrorField])
  function clearServerFieldError(field: AdditionalFormField) {
    setServerFieldErrors((current) => {
      if (!(field in current)) return current
      const next = { ...current }
      delete next[field]
      return next
    })
    setFirstServerErrorField((current) => (current === field ? null : current))
  }
  const invalidDates = isLeave && (!startsOn || !endsOn || startsOn > endsOn)
  const normalizedPurpose = trimPythonWhitespace(purpose)
  const normalizedExplanation = trimPythonWhitespace(explanation)
  const invalidExplanation = isLeave && basis === 'other' && normalizedExplanation.length === 0
  const startsLocalError =
    (touched || touchedFields.startsOn) && !startsOn
      ? 'Введите существующую дату в формате ДД.ММ.ГГГГ.'
      : undefined
  const endsLocalError =
    (touched || touchedFields.endsOn) && (!endsOn || startsOn > endsOn)
      ? startsOn && endsOn && startsOn > endsOn
        ? 'Окончание должно быть не раньше начала.'
        : 'Введите существующую дату в формате ДД.ММ.ГГГГ.'
      : undefined
  const explanationLocalError =
    (touched || touchedFields.explanation) && invalidExplanation ? 'Добавьте пояснение.' : undefined
  const invalid = invalidDates || invalidExplanation
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    setTouchedFields({ startsOn: true, endsOn: true, explanation: true })
    setError('')
    setServerFieldErrors({})
    setFirstServerErrorField(null)
    if (invalid) {
      if (isLeave && !startsOn) startsOnInput.current?.focus()
      else if (isLeave && (!endsOn || startsOn > endsOn)) endsOnInput.current?.focus()
      else explanationInput.current?.focus()
      return
    }
    if (service?.action_available !== true || pending || uncertain) return
    if (isLeave && selectedFiles.length === 0) {
      setAttachmentError('Прикрепите минимум один подтверждающий файл.')
      document.getElementById('leave-files')?.focus()
      return
    }
    if (
      selectedFiles.length > 5 ||
      selectedFiles.some((file) => file.size === 0 || file.size > 10 * 1024 * 1024) ||
      selectedFiles.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024
    ) {
      setAttachmentError('Допустимо до 5 файлов, не более 10 МБ каждый и 50 МБ суммарно.')
      return
    }
    setPending(true)
    try {
      const formData = isTranscript
        ? {}
        : isAccounting
          ? { purpose: normalizedPurpose || null }
          : {
              basis,
              starts_on: startsOn,
              ends_on: endsOn,
              explanation: basis === 'other' ? normalizedExplanation : null,
            }
      const body = isLeave
        ? (() => {
            const multipart = new FormData()
            multipart.set('form_data', JSON.stringify(formData))
            selectedFiles.forEach((file) => multipart.append('files', file, file.name))
            return multipart
          })()
        : JSON.stringify({ service_code: serviceCode, form_data: formData })
      const result = await apiFetch<unknown>('/api/v1/applications', {
        method: 'POST',
        authenticated: true,
        signal: AbortSignal.timeout(30_000),
        body,
      })
      const expectedForm = isTranscript
        ? {}
        : isAccounting
          ? { purpose: normalizedPurpose || null }
          : {
              basis,
              starts_on: startsOn,
              ends_on: endsOn,
              explanation: basis === 'other' ? normalizedExplanation : null,
            }
      if (!isAdditionalApplicationResponse(result, serviceCode, expectedForm)) {
        throw new ApiClientError(
          'Сервер вернул некорректное подтверждение',
          'invalid_response',
          201,
        )
      }
      const response = result
      setApplicationId(response.id)
      queryClient.removeQueries({ queryKey: applicationsKey })
    } catch (cause) {
      const isUncertain =
        !(cause instanceof ApiClientError) ||
        cause.status === undefined ||
        cause.status >= 500 ||
        cause.code === 'invalid_response'
      setUncertain(isUncertain)
      const fieldErrorResult =
        cause instanceof ApiClientError && cause.status === 422
          ? getAdditionalFormErrors(cause.details)
          : null
      if (fieldErrorResult) {
        setServerFieldErrors(fieldErrorResult.errors)
        setFirstServerErrorField(fieldErrorResult.firstField)
        setError(fieldErrorResult.hasUnmapped ? getApplicationErrorMessage(cause) : '')
      } else {
        setServerFieldErrors({})
        setFirstServerErrorField(null)
        const isAttachmentError =
          cause instanceof ApiClientError &&
          ['attachment_required', 'invalid_attachment', 'attachment_limit_exceeded'].includes(
            cause.code,
          )
        if (cause instanceof ApiClientError && cause.code === 'attachment_required') {
          setAttachmentError('Прикрепите минимум один подтверждающий файл.')
        } else if (
          cause instanceof ApiClientError &&
          ['invalid_attachment', 'attachment_limit_exceeded'].includes(cause.code)
        ) {
          setAttachmentError(
            cause.code === 'invalid_attachment'
              ? 'Файл пустой, повреждён или не относится к PDF, JPG или PNG.'
              : 'Допустимо до 5 файлов, не более 10 МБ каждый и 50 МБ суммарно.',
          )
        }
        setError(
          isAttachmentError
            ? ''
            : isUncertain && cause instanceof ApiClientError && cause.status === 503
              ? 'Сервис временно недоступен. Заявление могло сохраниться; проверьте список заявлений перед повтором.'
              : isUncertain
                ? 'Ответ не получен. Заявление могло сохраниться; проверьте список заявлений перед повтором.'
                : getApplicationErrorMessage(cause),
        )
      }
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
      ) : servicesQuery.isPending ? (
        <LoadingState title="Загружаем доступность услуги…" />
      ) : servicesQuery.isError ? (
        <ErrorState
          title="Не удалось проверить доступность услуги"
          description="Повторите загрузку перед заполнением формы."
          onRetry={() => void servicesQuery.refetch()}
        />
      ) : !service ? (
        <ErrorState title="Услуга не найдена в каталоге" description="Вернитесь в каталог услуг." />
      ) : (
        <form className="application-form" onSubmit={handleSubmit} noValidate>
          <h2>Данные заявления</h2>
          <p>* — обязательные поля</p>
          {service.action_available === false && service.unavailable_reason && (
            <p className="service-unavailable" role="status">
              {service.unavailable_reason}
            </p>
          )}
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
                ref={basisInput}
                id="leave-basis"
                value={basis}
                disabled={pending}
                onChange={(event) => {
                  setBasis(event.target.value as typeof basis)
                  clearServerFieldError('basis')
                  clearServerFieldError('explanation')
                  setError('')
                }}
                aria-invalid={Boolean(serverFieldErrors.basis)}
                aria-describedby={serverFieldErrors.basis ? 'leave-basis-server-error' : undefined}
              >
                <option value="medical">Медицинское</option>
                <option value="family">Семейные обстоятельства</option>
                <option value="other">Иное</option>
              </select>
              {serverFieldErrors.basis && (
                <small id="leave-basis-server-error" role="alert">
                  {serverFieldErrors.basis}
                </small>
              )}
              <label htmlFor="leave-start">
                Дата начала <span aria-hidden="true">*</span>
              </label>
              <input
                ref={startsOnInput}
                id="leave-start"
                inputMode="numeric"
                placeholder="ДД.ММ.ГГГГ"
                value={startsText}
                disabled={pending}
                onChange={(event) => {
                  setStartsText(event.target.value)
                  clearServerFieldError('starts_on')
                }}
                onBlur={() => setTouchedFields((fields) => ({ ...fields, startsOn: true }))}
                aria-invalid={Boolean(serverFieldErrors.starts_on || startsLocalError)}
                aria-describedby={
                  serverFieldErrors.starts_on
                    ? 'leave-start-server-error'
                    : startsLocalError
                      ? 'leave-start-error'
                      : undefined
                }
              />
              <label htmlFor="leave-start-calendar">Выбрать дату начала</label>
              <input
                id="leave-start-calendar"
                type="date"
                value={startsOn}
                disabled={pending}
                onChange={(event) => {
                  setStartsText(formatRussianDate(event.target.value))
                  clearServerFieldError('starts_on')
                }}
                aria-invalid={Boolean(serverFieldErrors.starts_on || startsLocalError)}
                aria-describedby={
                  serverFieldErrors.starts_on
                    ? 'leave-start-server-error'
                    : startsLocalError
                      ? 'leave-start-error'
                      : undefined
                }
              />
              {(serverFieldErrors.starts_on || startsLocalError) && (
                <small
                  id={
                    serverFieldErrors.starts_on ? 'leave-start-server-error' : 'leave-start-error'
                  }
                  role="alert"
                >
                  {serverFieldErrors.starts_on ?? startsLocalError}
                </small>
              )}
              <label htmlFor="leave-end">
                Дата окончания <span aria-hidden="true">*</span>
              </label>
              <input
                ref={endsOnInput}
                id="leave-end"
                inputMode="numeric"
                placeholder="ДД.ММ.ГГГГ"
                value={endsText}
                disabled={pending}
                onChange={(event) => {
                  setEndsText(event.target.value)
                  clearServerFieldError('ends_on')
                }}
                onBlur={() => setTouchedFields((fields) => ({ ...fields, endsOn: true }))}
                aria-invalid={Boolean(serverFieldErrors.ends_on || endsLocalError)}
                aria-describedby={
                  serverFieldErrors.ends_on
                    ? 'leave-end-server-error'
                    : endsLocalError
                      ? 'leave-end-error'
                      : undefined
                }
              />
              <label htmlFor="leave-end-calendar">Выбрать дату окончания</label>
              <input
                id="leave-end-calendar"
                type="date"
                value={endsOn}
                disabled={pending}
                onChange={(event) => {
                  setEndsText(formatRussianDate(event.target.value))
                  clearServerFieldError('ends_on')
                }}
                aria-invalid={Boolean(serverFieldErrors.ends_on || endsLocalError)}
                aria-describedby={
                  serverFieldErrors.ends_on
                    ? 'leave-end-server-error'
                    : endsLocalError
                      ? 'leave-end-error'
                      : undefined
                }
              />
              {(serverFieldErrors.ends_on || endsLocalError) && (
                <small
                  id={serverFieldErrors.ends_on ? 'leave-end-server-error' : 'leave-end-error'}
                  role="alert"
                >
                  {serverFieldErrors.ends_on ?? endsLocalError}
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
                    disabled={pending}
                    onChange={(event) => {
                      setExplanation(event.target.value)
                      clearServerFieldError('explanation')
                    }}
                    onBlur={() => setTouchedFields((fields) => ({ ...fields, explanation: true }))}
                    aria-invalid={Boolean(serverFieldErrors.explanation || explanationLocalError)}
                    aria-describedby={
                      serverFieldErrors.explanation
                        ? 'leave-explanation-server-error'
                        : explanationLocalError
                          ? 'leave-explanation-error'
                          : undefined
                    }
                  />
                  {(serverFieldErrors.explanation || explanationLocalError) && (
                    <small
                      id={
                        serverFieldErrors.explanation
                          ? 'leave-explanation-server-error'
                          : 'leave-explanation-error'
                      }
                      role="alert"
                    >
                      {serverFieldErrors.explanation ?? explanationLocalError}
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
                <label htmlFor="leave-files">Подтверждающие файлы (PDF, JPG, PNG) *</label>
                <input
                  id="leave-files"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                  multiple
                  disabled={pending}
                  onChange={(event) => {
                    const incoming = Array.from(event.target.files ?? [])
                    setSelectedFiles((current) => [...current, ...incoming].slice(0, 6))
                    setAttachmentError('')
                    event.currentTarget.value = ''
                  }}
                  aria-invalid={Boolean(attachmentError)}
                  aria-describedby={attachmentError ? 'leave-files-error' : 'leave-files-help'}
                />
                <small id="leave-files-help">До 5 файлов, 10 МБ каждый и 50 МБ суммарно.</small>
                {selectedFiles.length > 0 && (
                  <ul aria-label="Выбранные файлы">
                    {selectedFiles.map((file, index) => (
                      <li key={`${file.name}-${file.size}-${index}`}>
                        {file.name} — {(file.size / (1024 * 1024)).toFixed(2)} МБ{' '}
                        <button
                          type="button"
                          disabled={pending}
                          aria-label={`Удалить ${file.name}`}
                          onClick={() =>
                            setSelectedFiles((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          Удалить
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {attachmentError && (
                  <small id="leave-files-error" role="alert">
                    {attachmentError}
                  </small>
                )}
              </div>
            </>
          )}
          {isAccounting && (
            <>
              <label htmlFor="accounting-purpose">Цель получения (необязательно)</label>
              <input
                ref={purposeInput}
                id="accounting-purpose"
                value={purpose}
                disabled={pending}
                onChange={(event) => {
                  setPurpose(event.target.value)
                  clearServerFieldError('purpose')
                }}
                maxLength={300}
                aria-invalid={Boolean(serverFieldErrors.purpose)}
                aria-describedby={
                  serverFieldErrors.purpose ? 'accounting-purpose-error' : undefined
                }
              />
              {serverFieldErrors.purpose && (
                <small id="accounting-purpose-error" role="alert">
                  {serverFieldErrors.purpose}
                </small>
              )}
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
              {pending || uncertain
                ? 'Результат отправки не подтверждён. Покинуть форму?'
                : 'Выйти без сохранения?'}
            </h2>
            <p>
              {pending || uncertain
                ? 'Заявление может сохраниться; проверьте его в списке заявлений.'
                : 'Введённые данные ещё не отправлены и будут потеряны.'}
            </p>
            <div className="unsaved-dialog__actions">
              <button type="button" onClick={() => blocker.reset()}>
                Продолжить заполнение
              </button>
              <button type="button" onClick={() => blocker.proceed()}>
                {pending || uncertain ? 'Покинуть форму' : 'Выйти'}
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
