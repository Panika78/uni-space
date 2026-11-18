import { useInfiniteQuery } from '@tanstack/react-query'

import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import './announcements.css'

export type Announcement = components['schemas']['Announcement']
type Page = { items: Announcement[]; next_cursor: string | null }
export type AnnouncementScope = { userId: string; courseId: string } & (
  { role: 'teacher'; groupId: string } | { role: 'student' }
)

export const announcementKeys = (scope: AnnouncementScope) =>
  ['course-announcements', scope.userId, scope.role, scope.courseId] as const

export async function getAnnouncementPage(
  scope: AnnouncementScope,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const path =
    scope.role === 'teacher'
      ? `teaching/courses/${scope.courseId}/groups/${scope.groupId}/announcements`
      : `academics/courses/${scope.courseId}/announcements`
  let canPublishToAll = false
  let teacherId: string | null = null
  const page = await apiFetch<Page>(
    `/api/v1/${path}${cursor ? '?' + new URLSearchParams({ cursor }) : ''}`,
    {
      authenticated: true,
      signal,
      onResponseHeaders(headers) {
        canPublishToAll = headers.get('X-Can-Publish-To-All-Groups') === 'true'
        teacherId = headers.get('X-Announcement-Teacher-Id')
      },
    },
  )
  return { ...page, canPublishToAll, teacherId }
}

export function useAnnouncements(scope: AnnouncementScope) {
  return useInfiniteQuery({
    queryKey: [...announcementKeys(scope), scope.role === 'teacher' ? scope.groupId : null],
    queryFn: ({ pageParam, signal }) => getAnnouncementPage(scope, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    gcTime: 0,
    retry: false,
  })
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Moscow',
})

export function AnnouncementFeed({ scope }: { scope: AnnouncementScope }) {
  const query = useAnnouncements(scope)
  if (query.isPending) return <LoadingState title="Загружаем объявления…" variant="compact" />
  const denied =
    query.error instanceof ApiClientError && [403, 404].includes(query.error.status ?? 0)
  if (denied || (query.isError && !query.isFetchNextPageError)) {
    return (
      <ErrorState
        title={denied ? 'Объявления недоступны' : 'Не удалось загрузить объявления'}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  if (items.length === 0) return <EmptyState title="Объявлений пока нет" />
  return (
    <>
      <ul className="announcement-feed">
        {items.map((item) => (
          <li key={item.id}>
            <details>
              <summary>
                <strong>{item.title}</strong>
                {item.is_important && <span className="announcement-important">Важное</span>}
                <span className="announcement-byline">
                  <time dateTime={item.created_at}>
                    {dateFormat.format(new Date(item.created_at))}
                  </time>
                  {' · '}
                  {item.teacher.full_name}
                </span>
                <span className="announcement-excerpt">{item.excerpt}</span>
              </summary>
              <p className="announcement-body">{item.body}</p>
            </details>
          </li>
        ))}
      </ul>
      {query.isFetchNextPageError && <p role="alert">Не удалось загрузить следующую страницу.</p>}
      {query.hasNextPage && (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? 'Загружаем…'
            : query.isFetchNextPageError
              ? 'Повторить загрузку'
              : 'Показать ещё'}
        </button>
      )}
    </>
  )
}
