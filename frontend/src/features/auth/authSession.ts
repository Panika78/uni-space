import type { QueryClient } from '@tanstack/react-query'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

type LoginRequest = components['schemas']['LoginRequest']
type TokenResponse = components['schemas']['TokenResponse']
type LogoutResponse = components['schemas']['LogoutResponse']
type Status = 'initializing' | 'authenticated' | 'unauthenticated'
type SharedState = {
  epoch: string
  blocked: boolean
  pending: boolean
  ended?: boolean
}
export const authStorageKey = 'uni-space.auth-state'
export const authEpochStorageKey = 'uni-space.auth-epoch'
const emptyState: SharedState = { epoch: 'initial', blocked: false, pending: false }
const compatibilityMessage =
  'Для безопасного входа нужен современный браузер с поддержкой нескольких вкладок и хранилища сайта.'
const logoutUnconfirmedMessage = 'Не удалось завершить выход. Войдите снова, чтобы продолжить.'
type AuthSnapshot = {
  status: Status
  message: string
  busy: boolean
}

export class AuthSession {
  private token: string | undefined
  private generation = new AbortController()
  private listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private startPromise: Promise<void> | undefined
  private epoch = 'initial'
  private snapshot: AuthSnapshot = {
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
    let raw: string | null
    try {
      raw = localStorage.getItem(authStorageKey)
    } catch {
      throw new ApiClientError('Browser storage is unavailable', 'coordination_unavailable')
    }
    if (!raw) return emptyState
    let value: SharedState
    try {
      value = JSON.parse(raw) as SharedState
    } catch {
      throw new ApiClientError('Browser auth state is unreadable', 'invalid_auth_state')
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.epoch !== 'string' ||
      typeof value.blocked !== 'boolean' ||
      typeof value.pending !== 'boolean'
    )
      throw new ApiClientError('Invalid auth coordination state', 'invalid_auth_state')
    return value
  }

  private readEpoch() {
    try {
      return localStorage.getItem(authEpochStorageKey) ?? 'initial'
    } catch {
      throw new ApiClientError('Browser storage is unavailable', 'coordination_unavailable')
    }
  }

  private writeState(state: SharedState) {
    try {
      localStorage.setItem(authStorageKey, JSON.stringify(state))
    } catch {
      throw new ApiClientError('Browser storage is unavailable', 'coordination_unavailable')
    }
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
      const hasEnded = state.epoch === epoch && state.ended === true && !state.pending
      if (
        epoch !== this.epoch ||
        (hasEnded &&
          (this.snapshot.status !== 'unauthenticated' || this.snapshot.message !== '')) ||
        ((state.blocked || state.ended) && this.snapshot.status === 'authenticated')
      ) {
        this.epoch = epoch
        this.clearSession()
      }
    } catch {
      this.clearSession(compatibilityMessage)
    }
  }

  private requireCurrent(epoch: string) {
    this.synchronize()
    if (this.readEpoch() !== epoch || this.epoch !== epoch)
      throw new DOMException('Authorization changed', 'AbortError')
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    if (!navigator.locks)
      throw new ApiClientError('Web Locks unavailable', 'coordination_unavailable')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(
        new ApiClientError('Authentication lock wait timed out', 'lock_wait_timeout'),
      )
    }, 10000)
    try {
      return await navigator.locks.request('uni-space.auth', { signal: controller.signal }, () => {
        // The deadline belongs only to acquisition, never to the cookie operation.
        clearTimeout(timer)
        controller.signal.throwIfAborted()
        return action()
      })
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      clearTimeout(timer)
    }
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
      if (!navigator.locks)
        throw new ApiClientError('Browser coordination is unavailable', 'coordination_unavailable')
      // Probe a separate key: initialization must not overwrite an active rotation marker.
      try {
        localStorage.setItem('uni-space.storage-probe', '1')
        localStorage.removeItem('uni-space.storage-probe')
      } catch {
        throw new ApiClientError('Browser storage is unavailable', 'coordination_unavailable')
      }
      this.epoch = this.readEpoch()
      const state = this.readState()
      // A blocked logout or confirmed end never restores the old cookie on reload.
      if (state.epoch === this.epoch && (state.blocked || state.ended) && !state.pending) {
        this.clearSession()
        return
      }
      await this.refresh()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'lock_wait_timeout') this.synchronize()
      if (this.snapshot.status === 'initializing')
        this.clearSession(isCoordinationUnavailable(error) ? compatibilityMessage : '')
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
        this.clearSession()
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
          this.clearSession()
        }
        throw error
      }
    }).catch((error: unknown) => {
      if (
        error instanceof ApiClientError &&
        error.code === 'lock_wait_timeout' &&
        this.readEpoch() === epoch
      ) {
        // No cookie was sent and no journal entry is ours to change.
        this.clearSession()
      }
      throw error
    })
  }

  private beginChange(expectedEpoch?: string) {
    this.clearSession()
    const epoch = crypto.randomUUID()
    // Intents use their own key. Only lock owners write the operation journal.
    // A mismatched journal/epoch blocks restoration even if this tab closes now.
    let previousEpoch: string
    try {
      previousEpoch = this.readEpoch()
      if (expectedEpoch !== undefined && previousEpoch !== expectedEpoch) {
        this.synchronize()
        throw new DOMException('Authorization changed', 'AbortError')
      }
      localStorage.setItem(authEpochStorageKey, epoch)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiClientError('Auth storage unavailable', 'coordination_unavailable')
    }
    this.epoch = epoch
    this.update('unauthenticated', '', true)
    return { epoch, previousEpoch }
  }

  login = async (body: LoginRequest) => {
    let epoch: string | undefined
    try {
      const change = this.beginChange()
      epoch = change.epoch
      await this.withLock(async () => {
        this.requireCurrent(epoch!)
        let previousState: SharedState
        try {
          previousState = this.readState()
        } catch (error) {
          if (!isInvalidAuthState(error)) throw error
          previousState = emptyState
        }
        const canPreserveEnded =
          previousState.epoch === change.previousEpoch &&
          previousState.ended === true &&
          !previousState.pending
        this.writeState({ epoch: epoch!, blocked: true, pending: false })
        this.update('unauthenticated', '', true)
        let result: TokenResponse
        try {
          result = await apiFetch<TokenResponse>('/api/v1/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify(body),
          })
        } catch (error) {
          this.requireCurrent(epoch!)
          if (
            canPreserveEnded &&
            error instanceof ApiClientError &&
            error.status === 401 &&
            error.code === 'invalid_credentials'
          ) {
            // A definitive rejection cannot create a session; uncertainty still stays blocked.
            this.writeState({ epoch: epoch!, blocked: true, pending: false, ended: true })
          }
          throw error
        }
        this.requireCurrent(epoch!)
        requireTokenResponse(result)
        this.writeState({ epoch: epoch!, blocked: false, pending: false })
        this.token = result.access_token
        this.update('authenticated')
      })
      return true
    } catch (error) {
      if (epoch === undefined || this.epoch === epoch)
        this.update('unauthenticated', getLoginErrorMessage(error))
      return false
    }
  }

  logout = async () => {
    let epoch: string | undefined
    try {
      const sourceEpoch = this.epoch
      this.synchronize()
      if (this.epoch !== sourceEpoch) return
      const accessToken = this.token
      const sourceJournalEpoch = this.readState().epoch
      epoch = this.beginChange(sourceEpoch).epoch
      await this.withLock(async () => {
        this.requireCurrent(epoch!)
        if (this.readState().epoch !== sourceJournalEpoch)
          throw new DOMException('Authorization changed', 'AbortError')
        // Block cookie restoration before dispatch, including lost responses.
        this.writeState({ epoch: epoch!, blocked: true, pending: false })
        const result = await apiFetch<LogoutResponse>('/api/v1/auth/logout', {
          method: 'POST',
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
          redirect: 'error',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15000),
        })
        this.requireCurrent(epoch!)
        if (!result.session_revoked) {
          this.update('unauthenticated', logoutUnconfirmedMessage)
          return
        }
        this.writeState({ epoch: epoch!, blocked: true, pending: false, ended: true })
        this.update('unauthenticated', 'Вы вышли из приложения.')
      })
    } catch (error) {
      if (epoch === undefined && error instanceof DOMException && error.name === 'AbortError')
        return
      if (epoch === undefined || this.epoch === epoch)
        this.update(
          'unauthenticated',
          error instanceof DOMException && error.name === 'AbortError'
            ? ''
            : isCoordinationUnavailable(error)
              ? compatibilityMessage
              : logoutUnconfirmedMessage,
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

function isCoordinationUnavailable(error: unknown) {
  return error instanceof ApiClientError && error.code === 'coordination_unavailable'
}

function isInvalidAuthState(error: unknown) {
  return error instanceof ApiClientError && error.code === 'invalid_auth_state'
}

export function getLoginErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError')
      return 'Не удалось выполнить вход. Проверьте соединение и попробуйте ещё раз.'
    if (error.name === 'AbortError') return ''
  }
  if (!(error instanceof ApiClientError)) return 'Не удалось выполнить вход. Попробуйте ещё раз.'
  if (error.status !== undefined && error.status >= 500 && error.status < 600)
    return 'Не удалось выполнить вход. Попробуйте позже.'
  switch (error.code) {
    case 'lock_wait_timeout':
      return 'Не удалось выполнить вход. Попробуйте ещё раз.'
    case 'coordination_unavailable':
      return compatibilityMessage
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
      return 'Не удалось выполнить вход. Проверьте соединение и попробуйте ещё раз.'
    default:
      return 'Не удалось выполнить вход. Попробуйте ещё раз.'
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
