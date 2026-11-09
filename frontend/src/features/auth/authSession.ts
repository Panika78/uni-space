import type { QueryClient } from '@tanstack/react-query'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

type LoginRequest = components['schemas']['LoginRequest']
type TokenResponse = components['schemas']['TokenResponse']
type Status = 'initializing' | 'authenticated' | 'unauthenticated'
type SharedState = { epoch: string; blocked: boolean; pending: boolean; ended?: boolean }
export const authStorageKey = 'uni-space.auth-state'
export const authEpochStorageKey = 'uni-space.auth-epoch'
const emptyState: SharedState = { epoch: 'initial', blocked: false, pending: false }
const interruptedMessage =
  'Не удалось подтвердить состояние сессии. Войдите снова или повторите выход.'

export class AuthSession {
  private token: string | undefined
  private generation = new AbortController()
  private listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private startPromise: Promise<void> | undefined
  private epoch = 'initial'
  private snapshot: { status: Status; message: string; busy: boolean } = {
    status: 'initializing',
    message: '',
    busy: false,
  }

  constructor(private queryClient: QueryClient) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(status: Status, message = '', busy = false) {
    this.snapshot = { status, message, busy }
    this.listeners.forEach((listener) => listener())
  }

  private readState(): SharedState {
    const raw = localStorage.getItem(authStorageKey)
    if (!raw) return emptyState
    const value = JSON.parse(raw) as SharedState
    if (
      typeof value.epoch !== 'string' ||
      typeof value.blocked !== 'boolean' ||
      typeof value.pending !== 'boolean'
    )
      throw new Error('Invalid auth coordination state')
    return value
  }

  private readEpoch() {
    return localStorage.getItem(authEpochStorageKey) ?? 'initial'
  }

  private writeState(state: SharedState) {
    localStorage.setItem(authStorageKey, JSON.stringify(state))
  }

  private clearSession(message = '') {
    this.token = undefined
    this.generation.abort()
    this.generation = new AbortController()
    void this.queryClient.cancelQueries()
    this.queryClient.clear()
    this.update('unauthenticated', message)
  }

  synchronize = () => {
    try {
      const state = this.readState()
      const epoch = this.readEpoch()
      if (
        epoch !== this.epoch ||
        ((state.blocked || state.ended) && this.snapshot.status === 'authenticated')
      ) {
        this.epoch = epoch
        this.clearSession(
          state.blocked
            ? interruptedMessage
            : 'Авторизация изменена в другой вкладке. Войдите снова или обновите страницу.',
        )
      }
    } catch {
      this.clearSession('Для входа разрешите локальное хранилище браузера.')
    }
  }

  private requireCurrent(epoch: string) {
    this.synchronize()
    if (this.readEpoch() !== epoch || this.epoch !== epoch)
      throw new DOMException('Authorization changed', 'AbortError')
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('Web Locks unavailable')
    return navigator.locks.request('uni-space.auth', action)
  }

  start = () => {
    this.startPromise ??= this.initialize()
    return this.startPromise
  }

  private async initialize() {
    // A remounted provider must not reuse data from an earlier auth owner.
    void this.queryClient.cancelQueries()
    this.queryClient.clear()
    try {
      if (!navigator.locks) throw new Error('Web Locks unavailable')
      // Probe a separate key: initialization must not overwrite an active rotation marker.
      localStorage.setItem('uni-space.storage-probe', '1')
      localStorage.removeItem('uni-space.storage-probe')
      this.epoch = this.readEpoch()
      await this.refresh()
    } catch {
      if (this.snapshot.status === 'initializing')
        this.clearSession(
          'Вход недоступен. Нужен браузер с Web Locks и доступным локальным хранилищем.',
        )
    }
  }

  refresh = (): Promise<void> => {
    this.refreshPromise ??= this.rotateSession().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async rotateSession() {
    const epoch = this.epoch
    await this.withLock(async () => {
      this.requireCurrent(epoch)
      const state = this.readState()
      if (state.epoch !== epoch || state.blocked || state.pending || state.ended) {
        this.clearSession(state.ended ? '' : interruptedMessage)
        throw new DOMException('Session recovery blocked', 'AbortError')
      }
      // Durable before dispatch: closing a tab or losing a response must never retry this cookie.
      this.writeState({ ...state, pending: true })
      try {
        const result = await apiFetch<TokenResponse>('/api/v1/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15000),
        })
        this.requireCurrent(epoch)
        requireTokenResponse(result)
        this.writeState({ ...state, pending: false })
        this.token = result.access_token
        this.update('authenticated')
      } catch (error) {
        if (this.readEpoch() === epoch) {
          const isUnauthenticated =
            error instanceof ApiClientError &&
            error.status === 401 &&
            ['invalid_refresh', 'invalid_access', 'session_invalid'].includes(error.code)
          this.writeState({
            epoch,
            pending: !isUnauthenticated,
            blocked: !isUnauthenticated,
            ended: isUnauthenticated,
          })
          this.clearSession(isUnauthenticated ? '' : interruptedMessage)
        }
        throw error
      }
    })
  }

  private beginChange() {
    this.clearSession()
    const epoch = crypto.randomUUID()
    // Intents use their own key. Only lock owners write the operation journal.
    // A mismatched journal/epoch blocks restoration even if this tab closes now.
    localStorage.setItem(authEpochStorageKey, epoch)
    this.epoch = epoch
    this.update('unauthenticated', '', true)
    return epoch
  }

  login = async (body: LoginRequest) => {
    let epoch: string | undefined
    try {
      epoch = this.beginChange()
      await this.withLock(async () => {
        this.requireCurrent(epoch!)
        this.writeState({ epoch: epoch!, blocked: true, pending: false })
        const result = await apiFetch<TokenResponse>('/api/v1/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(body),
        })
        this.requireCurrent(epoch!)
        requireTokenResponse(result)
        this.writeState({ epoch: epoch!, blocked: false, pending: false })
        this.token = result.access_token
        this.update('authenticated')
      })
    } catch (error) {
      if (epoch === undefined || this.epoch === epoch)
        this.update('unauthenticated', getLoginErrorMessage(error))
    }
  }

  logout = async () => {
    let epoch: string | undefined
    try {
      epoch = this.beginChange()
      await this.withLock(async () => {
        this.requireCurrent(epoch!)
        this.writeState({ epoch: epoch!, blocked: true, pending: false })
        await apiFetch<void>('/api/v1/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15000),
        })
        this.requireCurrent(epoch!)
        this.writeState({ epoch: epoch!, blocked: true, pending: false })
        this.update('unauthenticated', 'Выход подтверждён сервером.')
      })
    } catch {
      if (epoch === undefined || this.epoch === epoch)
        this.update(
          'unauthenticated',
          'Данные скрыты, но сервер не подтвердил выход. Повторите выход или войдите снова.',
        )
    }
  }

  beginRequest = () => {
    this.synchronize()
    if (!this.token) throw new DOMException('Not authenticated', 'AbortError')
    const epoch = this.epoch
    const token = this.token
    return {
      token,
      signal: this.generation.signal,
      assertCurrent: () => {
        this.requireCurrent(epoch)
        if (!this.token) throw new DOMException('Not authenticated', 'AbortError')
      },
      refresh: async () => {
        this.requireCurrent(epoch)
        // Another request in this tab may already have refreshed this access.
        if (this.token === token) await this.refresh()
        this.requireCurrent(epoch)
        if (!this.token) throw new DOMException('Not authenticated', 'AbortError')
        return this.token
      },
      invalidate: () => {
        this.requireCurrent(epoch)
        localStorage.setItem(authEpochStorageKey, crypto.randomUUID())
        this.synchronize()
      },
    }
  }
}

export function getLoginErrorMessage(error: unknown) {
  if (!(error instanceof ApiClientError))
    return 'Вход недоступен в этом браузере. Проверьте поддержку Web Locks и доступ к хранилищу.'
  switch (error.code) {
    case 'invalid_credentials':
      return 'Неверный логин или пароль.'
    case 'rate_limited': {
      const raw = error.retryAfter
      const seconds =
        raw && /^\d+$/.test(raw)
          ? Number(raw)
          : raw
            ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
            : NaN
      return Number.isFinite(seconds)
        ? `Слишком много попыток. Повторите через ${Math.max(1, seconds)} сек.`
        : 'Слишком много попыток. Подождите минуту перед новой попыткой.'
    }
    case 'request_too_large':
      return 'Слишком большой запрос. Сократите логин или пароль.'
    case 'origin_not_allowed':
      return 'Вход с этого адреса недоступен. Обратитесь к администратору.'
    case 'network_error':
      return 'Не удалось подтвердить вход. Проверьте соединение и войдите снова.'
    default:
      return 'Не удалось войти. Проверьте данные и повторите попытку.'
  }
}

function requireTokenResponse(value: TokenResponse) {
  if (
    !value ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    value.token_type !== 'bearer' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new ApiClientError('Invalid token response', 'invalid_response')
  }
}
