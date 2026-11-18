import { useEffect } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'

import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useStudentProfile } from '../profile/profileContext'
import './announcements.css'

export type Announcement = components['schemas']['Announcement']
type Page = { items: Announcement[]; next_cursor: string | null }
export type AnnouncementScope = {
  userId: string
  courseId: string
  groupId: string
  role: 'teacher' | 'student'
}

class AnnouncementGroupChanged extends Error {}

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
  let serverGroup: string | null = null
  const page = await apiFetch<Page>(
    `/api/v1/${path}${cursor ? '?' + new URLSearchParams({ cursor }) : ''}`,
    {
      authenticated: true,
      signal,
      onResponseHeaders(headers) {
        canPublishToAll = headers.get('X-Can-Publish-To-All-Groups') === 'true'
        serverGroup = headers.get('X-Announcement-Group-Id')
      },
    },
  )
  if (scope.role === 'student' && serverGroup !== scope.groupId) {
    throw new AnnouncementGroupChanged()
  }
  return { ...page, canPublishToAll }
}

export function useAnnouncements(scope: AnnouncementScope) {
  return useInfiniteQuery({
    queryKey: [...announcementKeys(scope), scope.groupId],
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

export function StudentAnnouncementFeed({ courseId }: { courseId: string }) {
  const profile = useStudentProfile()
  const userId = profile?.id
  const groupId = profile?.group.id
  const client = useQueryClient()
  useEffect(() => {
    const prefix = ['course-announcements', userId, 'student', courseId]
    client.removeQueries({
      queryKey: prefix,
      predicate: (query) => query.queryKey[prefix.length] !== groupId,
    })
  }, [client, courseId, groupId, userId])
  if (!groupId || !userId)
    return <LoadingState title="Загружаем учебную группу…" variant="compact" />
  return <AnnouncementFeed scope={{ role: 'student', groupId, courseId, userId }} />
}

export function AnnouncementFeed({ scope }: { scope: AnnouncementScope }) {
  const query = useAnnouncements(scope)
  const client = useQueryClient()
  const groupChanged = query.error instanceof AnnouncementGroupChanged
  const rejectedStudentCursor =
    scope.role === 'student' &&
    query.isFetchNextPageError &&
    query.error instanceof ApiClientError &&
    query.error.status === 422
  useEffect(() => {
    if (groupChanged || rejectedStudentCursor) {
      void client.invalidateQueries({ queryKey: ['student-profile'] })
    }
  }, [client, groupChanged, rejectedStudentCursor])
  if (query.isPending) return <LoadingState title="Загружаем объявления…" variant="compact" />
  const denied =
    query.error instanceof ApiClientError && [403, 404].includes(query.error.status ?? 0)
  if (
    denied ||
    groupChanged ||
    rejectedStudentCursor ||
    (query.isError && !query.isFetchNextPageError)
  ) {
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
