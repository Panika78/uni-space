import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { FormEvent } from 'react'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'

type StaffNews = components['schemas']['StaffNews']
type StaffNewsPageData = components['schemas']['StaffNewsPage']
type NewsContent = components['schemas']['NewsContent']

const staffNewsKey = ['staff-news'] as const
const newsFeedKey = ['news', 'feed'] as const

function messageForError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'Сессия завершена. Войдите в систему снова.'
    if (error.status === 403) return 'У вас отозвано право публикации новостей.'
    if (error.status === 404) return 'Новость больше не найдена. Обновите список.'
    if (error.status === 422) return 'Проверьте заголовок и текст новости.'
  }
  return 'Не удалось сохранить изменения. Введённый текст сохранён в форме; проверьте связь и повторите запрос.'
}

function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('ru-RU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Moscow',
      }).format(new Date(value))
    : 'Черновик'
}

async function requestStaffNews(path: string, init: RequestInit = {}) {
  return apiFetch<StaffNews>(path, { ...init, authenticated: true })
}

export function StaffNewsPage() {
  const { id } = useParams()
  const isNew = id === 'new'
  const newsId = isNew ? undefined : id
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [titleDraft, setTitleDraft] = useState<{ id: string | undefined; value: string } | null>(
    null,
  )
  const [bodyDraft, setBodyDraft] = useState<{ id: string | undefined; value: string } | null>(null)
  const [success, setSuccess] = useState('')
  const listQuery = useInfiniteQuery({
    queryKey: staffNewsKey,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<StaffNewsPageData>(
        `/api/v1/staff/news?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        {
          authenticated: true,
          signal,
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !newsId && !isNew,
    staleTime: 0,
  })
  const itemQuery = useQuery({
    queryKey: [...staffNewsKey, newsId],
    queryFn: ({ signal }) =>
      apiFetch<StaffNews>(`/api/v1/staff/news/${encodeURIComponent(newsId ?? '')}`, {
        authenticated: true,
        signal,
      }),
    enabled: Boolean(newsId),
    staleTime: 0,
  })
  const item = itemQuery.data
  const editorTitle =
    titleDraft && titleDraft.id === newsId ? titleDraft.value : (item?.title ?? '')
  const editorBody = bodyDraft && bodyDraft.id === newsId ? bodyDraft.value : (item?.body ?? '')

  const saveMutation = useMutation({
    throwOnError: false,
    mutationFn: (content: NewsContent) =>
      requestStaffNews(
        newsId ? `/api/v1/staff/news/${encodeURIComponent(newsId)}` : '/api/v1/staff/news',
        { method: newsId ? 'PATCH' : 'POST', body: JSON.stringify(content) },
      ),
    onSuccess: async (news) => {
      setSuccess(news.is_published ? 'Изменения сохранены.' : 'Черновик сохранён.')
      await queryClient.invalidateQueries({ queryKey: staffNewsKey })
      await queryClient.invalidateQueries({ queryKey: newsFeedKey })
      await queryClient.invalidateQueries({ queryKey: ['news', 'item', news.id] })
      if (isNew) navigate(`/staff/news/${news.id}`, { replace: true })
    },
  })
  const publishMutation = useMutation({
    throwOnError: false,
    mutationFn: (publish: boolean) =>
      requestStaffNews(
        `/api/v1/staff/news/${encodeURIComponent(newsId ?? '')}/${publish ? 'publish' : 'unpublish'}`,
        {
          method: 'POST',
        },
      ),
    onSuccess: async (news) => {
      setSuccess(news.is_published ? 'Новость опубликована.' : 'Публикация снята.')
      await queryClient.invalidateQueries({ queryKey: staffNewsKey })
      await queryClient.invalidateQueries({ queryKey: newsFeedKey })
      await queryClient.invalidateQueries({ queryKey: ['news', 'item', news.id] })
    },
  })
  const error = saveMutation.error ?? publishMutation.error
  const isSaving = saveMutation.isPending || publishMutation.isPending

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSuccess('')
    saveMutation.mutate({ title: editorTitle, body: editorBody })
  }

  if (newsId && itemQuery.isPending) return <LoadingState title="Загружаем новость…" />
  if (newsId && itemQuery.isError)
    return (
      <section className="section-page">
        <ErrorState
          title="Не удалось открыть новость"
          description={messageForError(itemQuery.error)}
          onRetry={() => void itemQuery.refetch()}
        />
      </section>
    )

  return (
    <section className="section-page staff-news-page" aria-labelledby="staff-news-title">
      <p className="section-eyebrow">Рабочее пространство сотрудника</p>
      <h1 id="staff-news-title">Публикация новостей</h1>
      <p className="service-subtitle">Официальные новости университета</p>

      {!newsId && !isNew && (
        <>
          <Link className="staff-news-create" to="/staff/news/new">
            Создать новость
          </Link>
          {listQuery.isPending && <LoadingState title="Загружаем новости…" />}
          {listQuery.isError && (
            <ErrorState
              title="Не удалось загрузить список"
              description={messageForError(listQuery.error)}
              onRetry={() => void listQuery.refetch()}
            />
          )}
          {listQuery.data?.pages[0]?.items.length === 0 && (
            <EmptyState
              title="Новостей пока нет"
              description="Создайте черновик, чтобы подготовить публикацию."
            />
          )}
          {!!listQuery.data?.pages.some((page) => page.items.length > 0) && (
            <div className="staff-news-list" aria-label="Список новостей">
              {listQuery.data.pages
                .flatMap((page) => page.items)
                .map((news) => (
                  <Link className="staff-news-row" key={news.id} to={`/staff/news/${news.id}`}>
                    <span className="staff-news-row__status">
                      {news.is_published ? 'Опубликована' : 'Черновик'}
                    </span>
                    <strong>{news.title}</strong>
                    <span>{formatDate(news.published_at)}</span>
                  </Link>
                ))}
            </div>
          )}
          {listQuery.hasNextPage && (
            <button
              className="news-load-more"
              type="button"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё новости'}
            </button>
          )}
          {listQuery.isFetchNextPageError && (
            <ErrorState
              title="Не удалось загрузить продолжение списка"
              description={messageForError(listQuery.error)}
              onRetry={() => void listQuery.fetchNextPage()}
            />
          )}
        </>
      )}

      {(newsId || isNew) && (
        <div className="staff-news-editor">
          {newsId && (
            <Link to="/staff/news" className="news-back-link">
              ← К списку новостей
            </Link>
          )}
          <h2>{isNew ? 'Новая новость' : item?.title}</h2>
          {item && (
            <p className="staff-news-editor__meta">
              {item.is_published ? `Опубликовано ${formatDate(item.published_at)}` : 'Черновик'}
            </p>
          )}
          <form onSubmit={handleSave}>
            <label htmlFor="staff-news-title-input">Заголовок</label>
            <input
              id="staff-news-title-input"
              name="title"
              autoComplete="off"
              required
              minLength={1}
              maxLength={200}
              value={editorTitle}
              onChange={(event) => {
                setTitleDraft({ id: newsId, value: event.target.value })
                setSuccess('')
              }}
            />
            <div className="staff-news-editor__counter" aria-live="polite">
              {editorTitle.length}/200
            </div>
            <label htmlFor="staff-news-body-input">Текст новости</label>
            <textarea
              id="staff-news-body-input"
              name="body"
              required
              minLength={1}
              maxLength={20_000}
              rows={12}
              value={editorBody}
              onChange={(event) => {
                setBodyDraft({ id: newsId, value: event.target.value })
                setSuccess('')
              }}
            />
            <div className="staff-news-editor__counter" aria-live="polite">
              {editorBody.length}/20 000
            </div>
            {error && (
              <p className="staff-news-feedback staff-news-feedback--error" role="alert">
                {messageForError(error)}
              </p>
            )}
            {success && (
              <p className="staff-news-feedback" role="status">
                {success}
              </p>
            )}
            <div className="staff-news-actions">
              <button type="submit" disabled={isSaving}>
                {isSaving
                  ? 'Сохраняем…'
                  : item?.is_published
                    ? 'Сохранить изменения'
                    : 'Сохранить черновик'}
              </button>
              {newsId && !item?.is_published && (
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={async () => {
                    setSuccess('')
                    try {
                      await saveMutation.mutateAsync({ title: editorTitle, body: editorBody })
                      await publishMutation.mutateAsync(true)
                    } catch {
                      /* mutation state displays the error and retains form contents */
                    }
                  }}
                >
                  {isSaving ? 'Сохраняем…' : 'Опубликовать'}
                </button>
              )}
              {newsId && item?.is_published && (
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => publishMutation.mutate(false)}
                >
                  Снять с публикации
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
