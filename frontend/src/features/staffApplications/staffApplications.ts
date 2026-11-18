import { ApiClientError } from '../../shared/api/client'
import type { components, operations } from '../../shared/api/schema'

export const queuePath = '/staff/applications'
export const applicationsApi = '/api/v1/staff/applications'
export type StaffApplication = components['schemas']['StaffApplicationReadResponse']
export type ApplicationPage = components['schemas']['StaffApplicationPage']
export type HistoryPage = components['schemas']['ApplicationHistoryPage']
export type ReviewRequest = components['schemas']['ReviewApplicationRequest']
export type QueueQuery =
  operations['list_staff_applications_api_v1_staff_applications_get']['parameters']['query']

export const tabs = {
  new: 'Новые',
  in_review: 'В работе',
  completed: 'Завершённые',
  all: 'Все',
} as const

export const reviewLabels = {
  submitted: 'Подано',
  resubmitted: 'Подано повторно',
  in_review: 'В работе',
  needs_correction: 'На доработке',
  approved: 'Одобрено',
  rejected: 'Отклонено',
} satisfies Record<StaffApplication['review_status'], string>

export const documentLabels = {
  not_required: 'Не требуется',
  pending: 'Ожидает выдачи',
  failed: 'Ошибка выдачи PDF',
  ready: 'Готов',
} satisfies Record<StaffApplication['document_status'], string>

export function getDocumentLabel(application: StaffApplication) {
  if (application.review_status === 'rejected' && application.document_status === 'pending')
    return 'Не выдан'
  return documentLabels[application.document_status]
}

export const serviceLabels = {
  study_certificate: 'Справка об обучении',
  academic_transcript: 'Академическая выписка',
  academic_leave: 'Академический отпуск',
  accounting_certificate: 'Справка для бухгалтерии',
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
})
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'short',
})

export function formatApplicationDate(value: string, showTime = false) {
  return (showTime ? dateTimeFormat : dateFormat).format(new Date(value))
}

export function describeApplicationError(error: unknown) {
  if (error instanceof ApiClientError) {
    switch (error.status) {
      case 401:
        return 'Сессия завершена. Войдите снова.'
      case 403:
        return 'Доступ запрещён.'
      case 404:
        return 'Заявление или файл недоступны.'
      case 409:
        if (error.code === 'version_conflict')
          return 'Заявление изменилось. Обновите данные перед следующим действием.'
        if (error.code === 'invalid_transition')
          return 'Действие недоступно в текущем состоянии. Обновите данные.'
        return 'Документ пока недоступен. Обновите данные заявления.'
      case 422:
        return 'Проверьте параметры запроса и заполненные поля.'
      case 503:
        return 'Сервис временно недоступен. Попробуйте ещё раз.'
    }
    return error.message
  }
  return 'Не удалось связаться с сервером.'
}
