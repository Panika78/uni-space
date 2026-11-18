import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigationType, useSearchParams } from 'react-router-dom'
import { useRoleContext } from '../auth/RoleContext'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import {
  applicationsApi,
  describeApplicationError,
  getDocumentLabel,
  formatApplicationDate,
  queuePath,
  reviewLabels,
  serviceLabels,
  tabs,
} from './staffApplications'
import type { ApplicationPage, QueueQuery } from './staffApplications'
import './staffApplications.css'

type QueuePosition = { scroll: number; id?: string; pages: number }
const QueueSession = createContext<{
  positions: Map<string, QueuePosition>
  searches: Map<string, string>
  scope: string
} | null>(null)

export function StaffApplicationSessionLayout() {
  const { user_id, org_unit_id, permissions } = useRoleContext()
  const grants = permissions.map((grant) => JSON.stringify(grant)).sort()
  const signature = JSON.stringify([user_id, org_unit_id, grants])
  const session = useMemo(
    () => ({
      positions: new Map<string, QueuePosition>(),
      searches: new Map<string, string>(),
      scope: `${signature}:${crypto.randomUUID()}`,
    }),
    [signature],
  )
  return (
    <QueueSession.Provider value={session}>
      <Outlet />
    </QueueSession.Provider>
  )
}

export function useApplicationQueueSession() {
  const session = useContext(QueueSession)
  if (!session) throw new Error('StaffApplicationSessionLayout is required')
  return session
}

const filterNames = ['service_code', 'review_status', 'created_from', 'created_to'] as const

export function StaffApplicationQueue() {
  const { key } = useLocation()
  const { scope } = useApplicationQueueSession()
  return <ApplicationQueue key={`${scope}:${key}`} />
}

function ApplicationQueue() {
  const { positions, searches, scope } = useApplicationQueueSession()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const tab = rawTab && Object.hasOwn(tabs, rawTab) ? (rawTab as keyof typeof tabs) : 'new'
  const filters = new URLSearchParams({ tab } satisfies QueueQuery)
  for (const name of filterNames) {
    const value = params.get(name)
    if (value) filters.set(name, value)
  }
  const searchKey = typeof location.state?.searchKey === 'string' ? location.state.searchKey : ''
  const queryText = searches.get(searchKey) ?? ''
  const apiFilters = new URLSearchParams(filters)
  if (queryText) apiFilters.set('q', queryText)
  const search = filters.toString()
  const requestFilters = apiFilters.toString()
  const [restore] = useState(() =>
    navigationType === 'POP' ? positions.get(location.key) : undefined,
  )
  const list = useInfiniteQuery({
    queryKey: ['staff-applications', scope, location.key],
    initialPageParam: '',
    queryFn: async ({ signal, pageParam }) => {
      const items: ApplicationPage['items'] = []
      let cursor: string | null = pageParam
      let pages = 0
      // Revalidate every restored page against the current server scope.
      do {
        const query = new URLSearchParams(requestFilters)
        if (cursor) query.set('cursor', cursor)
        const page = await apiFetch<ApplicationPage>(`${applicationsApi}?${query}`, {
          authenticated: true,
          signal,
        })
        items.push(...page.items)
        cursor = page.next_cursor
        pages += 1
      } while (cursor && !pageParam && pages < (restore?.pages ?? 1))
      return { items, next_cursor: cursor, pages }
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const table = useRef<HTMLTableElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const didRestore = useRef(false)
  const pages = list.data?.pages.reduce((total, page) => total + page.pages, 0) ?? 0
  useLayoutEffect(() => {
    if (!list.isSuccess || !list.isFetchedAfterMount || list.isFetching) return
    const key = location.key
    if (restore && !didRestore.current) {
      didRestore.current = true
      const rowLink = restore.id
        ? table.current?.querySelector<HTMLElement>(`[data-application-id="${restore.id}"]`)
        : null
      ;(rowLink ?? heading.current)?.focus({ preventScroll: true })
      window.scrollTo({ top: restore.scroll, behavior: 'instant' })
    }
    function saveScroll() {
      const current = positions.get(key)
      if (!current && positions.size >= 50) {
        const oldest = positions.keys().next().value
        if (oldest !== undefined) positions.delete(oldest)
      }
      positions.set(key, { id: current?.id, scroll: window.scrollY, pages })
    }
    saveScroll()
    window.addEventListener('scroll', saveScroll, { passive: true })
    return () => window.removeEventListener('scroll', saveScroll)
  }, [
    list.isSuccess,
    list.isFetchedAfterMount,
    list.isFetching,
    location.key,
    pages,
    positions,
    restore,
  ])
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const invalidCursor =
    list.error instanceof ApiClientError && list.error.status === 422 && !!list.data
  const restart = () => {
    positions.delete(location.key)
    setParams(new URLSearchParams(search), { replace: true, state: { searchKey } })
  }
  return (
    <section className="section-page service-page staff-applications">
      <h1 ref={heading} tabIndex={-1}>
        Заявления
      </h1>
      <nav className="staff-applications__actions" aria-label="Очередь заявлений">
        {Object.entries(tabs).map(([value, label]) => {
          const query = new URLSearchParams(search)
          query.set('tab', value)
          return (
            <Link
              className="staff-applications__tab"
              key={value}
              aria-current={tab === value ? 'page' : undefined}
              to={`?${query}`}
              state={{ searchKey }}
            >
              {label}
            </Link>
          )
        })}
      </nav>
      <form
        key={location.key}
        className="staff-applications__filters"
        onSubmit={(event) => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          const query = new URLSearchParams({ tab })
          for (const name of filterNames) {
            const value = String(fields.get(name) ?? '').trim()
            if (value) query.set(name, value)
          }
          const text = String(fields.get('q') ?? '').trim()
          const nextSearchKey = text ? crypto.randomUUID() : ''
          if (text) {
            if (searches.size >= 100) {
              const oldest = searches.keys().next().value
              if (oldest !== undefined) searches.delete(oldest)
            }
            searches.set(nextSearchKey, text)
          }
          setParams(query, { state: { searchKey: nextSearchKey } })
        }}
      >
        <label>
          Номер или заявитель{' '}
          <input type="search" name="q" maxLength={200} defaultValue={queryText} />
        </label>
        <label>
          Услуга{' '}
          <select name="service_code" defaultValue={filters.get('service_code') ?? ''}>
            <option value="">Все услуги</option>
            {Object.entries(serviceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Статус{' '}
          <select name="review_status" defaultValue={filters.get('review_status') ?? ''}>
            <option value="">Все статусы вкладки</option>
            {Object.entries(reviewLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Дата создания с{' '}
          <input type="date" name="created_from" defaultValue={filters.get('created_from') ?? ''} />
        </label>
        <label>
          Дата создания по{' '}
          <input type="date" name="created_to" defaultValue={filters.get('created_to') ?? ''} />
        </label>
        <button className="auth-submit" type="submit">
          Применить
        </button>
        <Link to={`?tab=${tab}`}>Сбросить фильтры</Link>
      </form>
      {list.isPending || (!list.isFetchedAfterMount && !list.isError) ? (
        <LoadingState title="Загружаем заявления…" />
      ) : list.isError ? (
        <ErrorState
          title="Не удалось загрузить очередь"
          description={
            invalidCursor
              ? 'Страница очереди устарела. Начните с первой страницы.'
              : describeApplicationError(list.error)
          }
          onRetry={invalidCursor ? undefined : () => void list.refetch()}
        >
          {invalidCursor && (
            <button type="button" onClick={restart}>
              Начать заново
            </button>
          )}
        </ErrorState>
      ) : items.length === 0 ? (
        <EmptyState title="Заявлений нет" description="Измените вкладку или фильтры." />
      ) : (
        <>
          <table ref={table} className="applications-table staff-applications__table" role="table">
            <thead role="rowgroup">
              <tr role="row">
                {['№', 'Студент', 'Услуга', 'Дата', 'Рассмотрение', 'Документ'].map((label) => (
                  <th key={label} scope="col" role="columnheader">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup">
              {items.map((item) => (
                <tr key={item.id} role="row">
                  <td role="cell">
                    <Link
                      to={{ pathname: `${queuePath}/${item.id}`, search: location.search }}
                      state={{ fromQueue: true, searchKey }}
                      data-application-id={item.id}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                        positions.set(location.key, { id: item.id, scroll: window.scrollY, pages })
                      }}
                    >
                      № {item.id}
                    </Link>
                  </td>
                  <td role="cell">{item.applicant_display_name}</td>
                  <td role="cell">{item.service.title}</td>
                  <td role="cell">
                    <time dateTime={item.created_at}>{formatApplicationDate(item.created_at)}</time>
                  </td>
                  <td role="cell">
                    <span className="application-field-label" aria-hidden="true">
                      Рассмотрение
                    </span>
                    {reviewLabels[item.review_status]}
                  </td>
                  <td role="cell">
                    <span className="application-field-label" aria-hidden="true">
                      Документ
                    </span>
                    <span>{getDocumentLabel(item)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <button
              className="ui-state__action"
              type="button"
              disabled={list.isFetching}
              onClick={() => void list.fetchNextPage()}
            >
              Показать ещё
            </button>
          )}
          {list.isFetchingNextPage && (
            <LoadingState title="Загружаем следующую страницу…" variant="compact" />
          )}
        </>
      )}
    </section>
  )
}
