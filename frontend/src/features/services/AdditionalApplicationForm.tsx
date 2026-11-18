import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useBlocker } from 'react-router-dom'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { useAccessSuspended } from '../../shared/ui/AccessRecovery'
import { Icon } from '../../shared/ui/Icon'
import { applicationPath, applicationsKey, isApplicationAccessError } from './applicationQueries'

type Application = components['schemas']['ApplicationResponse']

type AdditionalFormField = 'basis' | 'starts_on' | 'ends_on' | 'explanation' | 'purpose'
type AdditionalFormErrors = Partial<Record<AdditionalFormField, string>>
const LEAVE_UPLOAD_TIMEOUT_MS = 180_000
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 5
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024

function getAttachmentError(retained: NonNullable<Application['attachments']>, added: File[]) {
  const count = retained.length + added.length
  if (count === 0) return 'Прикрепите минимум один подтверждающий файл.'
  const attachmentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
  }
  if (
    retained.some(({ mime_type }) => !Object.values(attachmentTypes).includes(mime_type)) ||
    added.some((file) => {
      const extension = /\.([a-z]+)$/i.exec(file.name)?.[1].toLowerCase()
      const expected = extension && attachmentTypes[extension]
      return !expected || (file.type && file.type !== expected)
    })
  )
    return 'Допустимы только PDF, JPG и PNG.'
  const sizes = [...retained.map((file) => file.size_bytes), ...added.map((file) => file.size)]
  if (
    count > MAX_ATTACHMENT_COUNT ||
    sizes.some((size) => size <= 0 || size > MAX_ATTACHMENT_BYTES) ||
    sizes.reduce((total, size) => total + size, 0) > MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    return 'Допустимо до 5 файлов, не более 10 МБ каждый и 50 МБ суммарно.'
  }
  return ''
}

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

export const trimPythonWhitespace = (text: string) => {
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

export function formatRussianDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : ''
}

export function hasValidDocumentMetadata(application: Record<string, unknown>): boolean {
  const document = application.document
  if (application.document_status !== 'ready') return document == null
  if (!document || typeof document !== 'object') return false
  const metadata = document as Record<string, unknown>
  return (
    typeof metadata.id === 'string' &&
    /^[1-9][0-9]*$/.test(metadata.id) &&
    typeof metadata.filename === 'string' &&
    metadata.filename.endsWith('.pdf') &&
    typeof metadata.issued_at === 'string' &&
    !Number.isNaN(Date.parse(metadata.issued_at))
  )
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
  const isAutomatic = serviceCode === 'academic_transcript'
  const expectedDocumentStatus = serviceCode === 'academic_leave' ? 'not_required' : 'pending'
  const hasExpectedWorkflow = isAutomatic
    ? app.review_status === 'approved' &&
      Number.isSafeInteger(app.version) &&
      Number(app.version) >= 2 &&
      ['pending', 'ready', 'failed'].includes(String(app.document_status))
    : app.review_status === 'submitted' &&
      app.version === 1 &&
      app.document_status === expectedDocumentStatus
  if (!service || typeof service !== 'object' || !form || typeof form !== 'object') return false
  const svc = service as Record<string, unknown>
  const data = form as Record<string, unknown>
  if (
    !isId(app.id) ||
    !Number.isSafeInteger(app.version) ||
    !isDateTime(app.created_at) ||
    !isDateTime(app.updated_at) ||
    !hasExpectedWorkflow ||
    !hasValidDocumentMetadata(app) ||
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
  serviceCode: string,
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
    const branch = parts[formDataIndex + 1]
    if (formDataIndex >= 0 && parts.length === formDataIndex + 3) {
      const model =
        serviceCode === 'academic_leave' ? 'AcademicLeaveFormData' : 'AccountingCertificateFormData'
      if (branch !== model) continue
    }
    const field = formDataIndex >= 0 ? parts.at(-1) : null
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

type Correction = {
  item: Application
  isCurrent: boolean
  historyIsCurrent: boolean
  refresh: (signal?: AbortSignal) => Promise<{
    item: Application
    events: components['schemas']['ApplicationHistoryEvent'][]
  }>
  onSuccess: (item: Application, submittedVersion: number, filesUnverified?: boolean) => void
  onAccessError: (error: ApiClientError) => void
  onCancel: () => void
}

type SubmissionAttempt = {
  version: number
  updatedAt?: string
  documentStatus?: Application['document_status']
  form: Record<string, unknown>
  retainedIds: string[]
  removedIds: string[]
  files: File[]
}

export function AdditionalApplicationForm({
  service,
  correction,
}: {
  service: Application['service']
  correction?: Correction
}) {
  const isSuspended = useAccessSuspended()
  const serviceCode = service.code
  const isLeave = serviceCode === 'academic_leave'
  const isTranscript = serviceCode === 'academic_transcript'
  const isAccounting = serviceCode === 'accounting_certificate'
  const isCorrection = Boolean(correction)
  const stored = correction?.item.form_data
  const leave = stored && 'basis' in stored ? stored : undefined
  const [basis, setBasis] = useState<'medical' | 'family' | 'other'>(leave?.basis ?? 'medical')
  const [startsText, setStartsText] = useState(formatRussianDate(leave?.starts_on ?? ''))
  const [endsText, setEndsText] = useState(formatRussianDate(leave?.ends_on ?? ''))
  const startsOn = parseRussianDate(startsText) ?? ''
  const endsOn = parseRussianDate(endsText) ?? ''
  const [explanation, setExplanation] = useState(leave?.explanation ?? '')
  const [purpose, setPurpose] = useState((stored && 'purpose' in stored && stored.purpose) || '')
  const [version, setVersion] = useState(correction?.item.version ?? 0)
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const retained = (correction?.item.attachments ?? []).filter(({ id }) => !removedIds.includes(id))
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [attempt, setAttempt] = useState<SubmissionAttempt | null>(null)
  const [canResume, setCanResume] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const exitButton = useRef<HTMLButtonElement>(null)
  const [conflict, setConflict] = useState(false)
  const [transitionRejected, setTransitionRejected] = useState(false)
  const busy = useRef(false)
  const active = useRef(false)
  const didFocus = useRef(false)
  const submission = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      submission.current?.abort()
    }
  }, [])
  const canCorrect = correction?.item.review_status === 'needs_correction' && !transitionRejected
  const needsVersionReview = Boolean(
    correction && (conflict || correction.item.version !== version),
  )
  const filesInput = useRef<HTMLInputElement>(null)
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
  const fieldsLocked = pending || uncertain
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
    selectedFiles.length > 0 ||
    removedIds.length > 0
  const draft = !applicationId && !uncertain && hasChanges
  const blocker = useBlocker(draft || pending || uncertain || resumed)
  const showLeaveDialog = (blocker.state === 'blocked' || closeRequested) && !isSuspended
  useLayoutEffect(() => {
    const dialog = leaveDialog.current
    if (!showLeaveDialog || !dialog) return
    const previous = document.activeElement
    if (!dialog.open) dialog.showModal()
    continueButton.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [showLeaveDialog])

  function cancelLeave() {
    if (blocker.state === 'blocked') blocker.reset()
    setCloseRequested(false)
  }
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draft || pending || uncertain || resumed) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [draft, pending, uncertain, resumed])
  useEffect(() => {
    setExitStatus(
      applicationId
        ? 'none'
        : pending
          ? 'submitting'
          : uncertain || resumed
            ? 'uncertain'
            : draft
              ? 'draft'
              : 'none',
    )
    return () => setExitStatus('none')
  }, [applicationId, draft, pending, resumed, setExitStatus, uncertain])
  useLayoutEffect(() => {
    if (pending || isSuspended) return
    if (attachmentError && !firstServerErrorField) filesInput.current?.focus()
    if (!firstServerErrorField) return
    const inputs: Record<AdditionalFormField, { current: HTMLElement | null }> = {
      basis: basisInput,
      starts_on: startsOnInput,
      ends_on: endsOnInput,
      explanation: explanationInput,
      purpose: purposeInput,
    }
    inputs[firstServerErrorField].current?.focus()
  }, [attachmentError, firstServerErrorField, isSuspended, pending])
  useEffect(() => {
    if (isSuspended || !isCorrection || didFocus.current) return
    didFocus.current = true
    const firstInput = basisInput.current ?? purposeInput.current
    firstInput?.focus()
  }, [isCorrection, isSuspended])
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
  async function verifyCorrection(sent: SubmissionAttempt | null) {
    if (!correction) return
    setCanResume(false)
    try {
      const { item: latest, events } = await correction.refresh(
        sent ? AbortSignal.timeout(30_000) : undefined,
      )
      if (!active.current) return
      if (sent) {
        const result = getCorrectionRecovery(latest, correction.item, sent, events)
        if (result === 'matched' || result === 'files_unverified') {
          correction.onSuccess(latest, sent.version + 1, result === 'files_unverified')
          return
        }
        const editable = latest.review_status === 'needs_correction'
        setCanResume(editable)
        setError(
          result === 'different'
            ? 'История подтверждает повторную подачу. Сохранённые поля или состав вложений отличаются от отправленных. Сверьте текущую версию заявления.'
            : editable
              ? 'Исход отправки пока не подтверждён. Первоначальный запрос ещё может завершиться. При продолжении возможен конфликт версий.'
              : 'Исход отправки пока не подтверждён. Проверьте состояние заявления ещё раз.',
        )
      } else if (latest.review_status !== 'needs_correction') {
        setTransitionRejected(true)
        setError('Повторная отправка больше недоступна. Статус заявления изменился.')
      }
    } catch (cause) {
      if (!active.current) return
      if (isApplicationAccessError(cause)) correction.onAccessError(cause)
      else setError('Не удалось проверить заявление и историю. Повторите проверку состояния.')
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || isSuspended) return
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
    if (
      uncertain ||
      (correction
        ? !canCorrect || !correction.isCurrent || needsVersionReview
        : !service.action_available)
    )
      return
    const attachmentIssue = isLeave ? getAttachmentError(retained, selectedFiles) : ''
    if (attachmentIssue) {
      setAttachmentError(attachmentIssue)
      filesInput.current?.focus()
      return
    }
    busy.current = true
    setPending(true)
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
    const sent = {
      version,
      updatedAt: correction?.item.updated_at,
      documentStatus: correction?.item.document_status,
      form: formData,
      retainedIds: retained.map(({ id }) => id),
      removedIds,
      files: selectedFiles,
    }
    const controller = new AbortController()
    submission.current = controller
    let dispatched = false
    try {
      if (correction && resumed) {
        const { item: latest } = await correction.refresh()
        if (!active.current || controller.signal.aborted) return
        if (latest.review_status !== 'needs_correction' || latest.version !== version) {
          setTransitionRejected(latest.review_status !== 'needs_correction')
          setConflict(latest.version !== version)
          setError('Заявление изменилось после проверки. Сверьте текущий статус и версию.')
          return
        }
      }
      const body = isLeave
        ? (() => {
            const multipart = new FormData()
            multipart.set('form_data', JSON.stringify(formData))
            if (correction) {
              multipart.set('expected_version', String(version))
              multipart.set('keep_attachment_ids', JSON.stringify(sent.retainedIds))
            }
            selectedFiles.forEach((file) => multipart.append('files', file, file.name))
            return multipart
          })()
        : JSON.stringify({
            ...(correction ? { expected_version: version } : { service_code: serviceCode }),
            form_data: formData,
          })
      dispatched = true
      const result = await apiFetch<unknown>(
        correction ? `${applicationPath(correction.item.id)}/resubmit` : '/api/v1/applications',
        {
          method: 'POST',
          authenticated: true,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(isLeave ? LEAVE_UPLOAD_TIMEOUT_MS : 30_000),
          ]),
          body,
        },
      )
      if (!active.current) return
      if (correction) {
        if (!isResubmissionResponse(result, correction.item, sent)) {
          throw new ApiClientError('Некорректное подтверждение', 'invalid_response')
        }
        correction.onSuccess(result, sent.version + 1)
      } else {
        if (!isAdditionalApplicationResponse(result, serviceCode, formData)) {
          throw new ApiClientError('Некорректное подтверждение', 'invalid_response', 201)
        }
        setApplicationId(result.id)
        queryClient.removeQueries({ queryKey: applicationsKey })
      }
    } catch (cause) {
      if (controller.signal.aborted || !active.current) return
      const isUncertain =
        !(cause instanceof ApiClientError) ||
        cause.status === undefined ||
        cause.status >= 500 ||
        cause.code === 'invalid_response'
      if (correction && isApplicationAccessError(cause)) {
        correction.onAccessError(cause)
        return
      }
      if (!dispatched) {
        setError('Не удалось проверить актуальное состояние. Повторите проверку перед отправкой.')
        return
      }
      if (correction && cause instanceof ApiClientError && cause.status === 409) {
        const invalidTransition = cause.code === 'invalid_transition'
        setTransitionRejected(invalidTransition)
        setConflict(cause.code === 'version_conflict')
        setError(
          invalidTransition
            ? 'Повторная отправка больше недоступна. Статус заявления изменился.'
            : cause.code === 'version_conflict'
              ? 'Заявление изменилось. Сверьте текущую версию, вложения и историю перед отправкой.'
              : 'Не удалось отправить исправления. Проверьте состояние заявления и повторите попытку.',
        )
        await verifyCorrection(null)
        return
      }
      setUncertain(isUncertain)
      if (correction && isUncertain) {
        setAttempt(sent)
        setError('Проверяем состояние заявления после отправки…')
        await verifyCorrection(sent)
        return
      }
      const fieldErrorResult =
        cause instanceof ApiClientError && cause.status === 422
          ? getAdditionalFormErrors(cause.details, serviceCode)
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
          filesInput.current?.focus()
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
        if (isAttachmentError) filesInput.current?.focus()
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
      submission.current = null
      busy.current = false
      setPending(false)
    }
  }
  async function handleVerify() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      await verifyCorrection(attempt)
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <section className={correction ? 'application-correction' : 'section-page service-page'}>
      {!correction && (
        <>
          <Link to="/services" className="service-back">
            <Icon name="left" /> К каталогу услуг
          </Link>
          <p className="section-eyebrow">Новое заявление</p>
          <h1>{applicationId ? 'Заявление создано' : service.title}</h1>
        </>
      )}
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
          <h2>{correction ? 'Исправление заявления' : 'Данные заявления'}</h2>
          <p>* — обязательные поля</p>
          {!correction && service.action_available === false && service.unavailable_reason && (
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
          {(!correction || canCorrect) && isLeave && (
            <>
              <label htmlFor="leave-basis">
                Основание <span aria-hidden="true">*</span>
              </label>
              <select
                ref={basisInput}
                id="leave-basis"
                value={basis}
                disabled={fieldsLocked}
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
                disabled={fieldsLocked}
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
                disabled={fieldsLocked}
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
                disabled={fieldsLocked}
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
                disabled={fieldsLocked}
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
                    disabled={fieldsLocked}
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
                  ref={filesInput}
                  id="leave-files"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                  multiple
                  disabled={fieldsLocked}
                  onChange={(event) => {
                    const incoming = Array.from(event.target.files ?? [])
                    setSelectedFiles((current) => [...current, ...incoming])
                    setAttachmentError('')
                    event.currentTarget.value = ''
                  }}
                  aria-invalid={Boolean(attachmentError)}
                  aria-describedby={attachmentError ? 'leave-files-error' : 'leave-files-help'}
                />
                <small id="leave-files-help">До 5 файлов, 10 МБ каждый и 50 МБ суммарно.</small>
                {Boolean(correction?.item.attachments?.length) && (
                  <ul aria-label="Ранее прикреплённые файлы">
                    {correction?.item.attachments?.map((file) => {
                      const isRemoved = removedIds.includes(file.id)
                      return (
                        <li key={file.id}>
                          {file.original_filename} — {(file.size_bytes / (1024 * 1024)).toFixed(2)}{' '}
                          МБ{' '}
                          <button
                            type="button"
                            disabled={fieldsLocked}
                            aria-label={`${isRemoved ? 'Оставить' : 'Убрать из нового набора'} ${file.original_filename}`}
                            onClick={() => {
                              setRemovedIds((ids) =>
                                isRemoved ? ids.filter((id) => id !== file.id) : [...ids, file.id],
                              )
                              setAttachmentError('')
                            }}
                          >
                            {isRemoved ? 'Оставить файл' : 'Убрать из нового набора'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {selectedFiles.length > 0 && (
                  <ul aria-label="Выбранные файлы">
                    {selectedFiles.map((file, index) => (
                      <li key={`${file.name}-${file.size}-${index}`}>
                        {file.name} — {(file.size / (1024 * 1024)).toFixed(2)} МБ{' '}
                        <button
                          type="button"
                          disabled={fieldsLocked}
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
          {(!correction || canCorrect) && isAccounting && (
            <>
              <label htmlFor="accounting-purpose">Цель получения (необязательно)</label>
              <input
                ref={purposeInput}
                id="accounting-purpose"
                value={purpose}
                disabled={fieldsLocked}
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
          {correction && !canCorrect && !error && (
            <p role="alert">Статус заявления изменился. Повторная отправка больше недоступна.</p>
          )}
          {correction && (uncertain || needsVersionReview || transitionRejected) && (
            <button type="button" disabled={pending} onClick={() => void handleVerify()}>
              Проверить состояние заявления
            </button>
          )}
          {correction && uncertain && canResume && canCorrect && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setUncertain(false)
                setAttempt(null)
                setResumed(true)
              }}
            >
              Продолжить редактирование
            </button>
          )}
          {correction &&
            canCorrect &&
            needsVersionReview &&
            !uncertain &&
            correction.isCurrent &&
            correction.historyIsCurrent &&
            correction.item.version !== version && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setVersion(correction.item.version)
                  setConflict(false)
                  setError('')
                }}
              >
                Использовать версию {correction.item.version} с моими исправлениями
              </button>
            )}
          {!correction && uncertain && (
            <Link to="/services?tab=applications">Проверить результат в моих заявлениях</Link>
          )}
          <div className="form-actions">
            {(!correction || canCorrect) && (
              <button
                className="service-action"
                type="submit"
                disabled={
                  pending ||
                  uncertain ||
                  (correction
                    ? !correction.isCurrent || needsVersionReview
                    : !service.action_available)
                }
              >
                {pending
                  ? 'Отправляем…'
                  : correction
                    ? 'Отправить повторно'
                    : !service.action_available
                      ? 'Подача пока недоступна'
                      : 'Отправить заявление'}{' '}
                <Icon name="arrow" />
              </button>
            )}
            {correction ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (hasChanges || uncertain || resumed) setCloseRequested(true)
                  else correction.onCancel()
                }}
              >
                Закрыть форму
              </button>
            ) : (
              <Link className="service-action service-action--light" to="/services">
                Отмена
              </Link>
            )}
          </div>
        </form>
      )}
      <dialog
        ref={leaveDialog}
        className="unsaved-dialog"
        role="alertdialog"
        aria-labelledby="additional-unsaved-title"
        aria-describedby="additional-unsaved-description"
        onCancel={(event) => {
          event.preventDefault()
          cancelLeave()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const first = continueButton.current
          const last = exitButton.current
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id="additional-unsaved-title">
          {pending || uncertain || resumed
            ? 'Результат отправки не подтверждён. Покинуть форму?'
            : 'Выйти без сохранения?'}
        </h2>
        <p id="additional-unsaved-description">
          {pending || uncertain || resumed
            ? 'Заявление может сохраниться. Проверьте его состояние после выхода.'
            : 'Введённые данные ещё не отправлены и будут потеряны.'}
        </p>
        <div className="unsaved-dialog__actions">
          <button ref={continueButton} type="button" onClick={cancelLeave}>
            Продолжить заполнение
          </button>
          <button
            ref={exitButton}
            type="button"
            onClick={() => {
              if (blocker.state === 'blocked') blocker.proceed()
              else correction?.onCancel()
            }}
          >
            {pending || uncertain || resumed ? 'Покинуть форму' : 'Выйти'}
          </button>
        </div>
      </dialog>
    </section>
  )
}

function isResubmissionResponse(
  value: unknown,
  previous: Application,
  attempt: SubmissionAttempt,
): value is Application {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Application>
  const form = item.form_data
  if (!form || typeof form !== 'object') return false
  return (
    item.id === previous.id &&
    item.version === attempt.version + 1 &&
    item.review_status === 'resubmitted' &&
    item.service?.code === previous.service.code &&
    item.document_status === previous.document_status &&
    typeof item.created_at === 'string' &&
    !Number.isNaN(Date.parse(item.created_at)) &&
    typeof item.updated_at === 'string' &&
    !Number.isNaN(Date.parse(item.updated_at)) &&
    item.feedback === null &&
    Array.isArray(item.attachments) &&
    item.attachments.length === attempt.retainedIds.length + attempt.files.length &&
    attempt.retainedIds.every((id) => item.attachments?.some((file) => file.id === id)) &&
    Object.entries(attempt.form).every(([key, expected]) => Reflect.get(form, key) === expected)
  )
}

function getCorrectionRecovery(
  item: Application,
  previous: Application,
  attempt: SubmissionAttempt,
  events: components['schemas']['ApplicationHistoryEvent'][],
): 'matched' | 'files_unverified' | 'different' | null {
  if (item.id !== previous.id || item.service.code !== previous.service.code) return null
  const steps = item.version - attempt.version
  if (steps < 1 || steps > 3 || item.document_status !== attempt.documentStatus) return null
  const [returned, resubmitted, started, decided] = events.slice(-(steps + 1))
  if (
    !returned ||
    returned.from_status !== 'in_review' ||
    returned.to_status !== 'needs_correction' ||
    !attempt.updatedAt ||
    !(Date.parse(returned.created_at) >= Date.parse(attempt.updatedAt)) ||
    !(Date.parse(events.at(-1)?.created_at ?? '') >= Date.parse(item.updated_at)) ||
    !resubmitted ||
    resubmitted.from_status !== 'needs_correction' ||
    resubmitted.to_status !== 'resubmitted' ||
    (steps >= 2 && (started?.from_status !== 'resubmitted' || started.to_status !== 'in_review')) ||
    (steps === 3 &&
      (decided?.from_status !== 'in_review' ||
        !['approved', 'rejected', 'needs_correction'].includes(decided.to_status))) ||
    events.at(-1)?.to_status !== item.review_status
  )
    return null
  const attachments = item.attachments ?? []
  if (
    attachments.length !== attempt.retainedIds.length + attempt.files.length ||
    !attempt.retainedIds.every((id) => attachments.some((file) => file.id === id)) ||
    attachments.some(({ id }) => attempt.removedIds.includes(id)) ||
    !Object.entries(attempt.form).every(
      ([key, expected]) => Reflect.get(item.form_data, key) === expected,
    )
  )
    return 'different'

  const added = attachments.filter(({ id }) => !attempt.retainedIds.includes(id))
  for (const file of attempt.files) {
    const index = added.findIndex(
      (attachment) =>
        attachment.original_filename === file.name &&
        attachment.size_bytes === file.size &&
        (!file.type || attachment.mime_type === file.type),
    )
    if (index === -1) return 'different'
    added.splice(index, 1)
  }
  // The committed transition and current metadata are visible. The history
  // cannot tie the bytes of a new attachment to the interrupted HTTP request.
  return attempt.files.length ? 'files_unverified' : 'matched'
}
