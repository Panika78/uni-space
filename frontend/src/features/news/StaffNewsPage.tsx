import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
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
    if (error.status === 409) {
      return error.code === 'idempotency_conflict'
        ? 'Не удалось подтвердить результат создания. Начните создание новости заново.'
        : 'Новость изменил другой сотрудник. Скопируйте введённый текст и обновите страницу перед повторным сохранением.'
    }
  }
  return 'Не удалось сохранить изменения. Введённый текст сохранён в форме; проверьте связь и повторите запрос.'
}

function codePointLength(value: string) {
  return Array.from(value).length
}

function getNewsStatus(news: Pick<StaffNews, 'is_published' | 'published_at'>) {
  if (news.is_published) return 'Опубликована'
  return news.published_at ? 'Снята с публикации' : 'Черновик'
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
  const [baseVersion, setBaseVersion] = useState<{ id: string; version: number } | null>(null)
  const [success, setSuccess] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [listAccessDenied, setListAccessDenied] = useState(false)
  const [itemAccessDenied, setItemAccessDenied] = useState<string | null>(null)
  const [createAccessDenied, setCreateAccessDenied] = useState(false)
  const createRequest = useRef<{ body: string; key: string } | null>(null)
  const isAccessDenied = (error: unknown) =>
    error instanceof ApiClientError && (error.status === 401 || error.status === 403)
  function handleAccessDenied(error: unknown, deniedNewsId = newsId) {
    if (!isAccessDenied(error)) return
    if (isNew) {
      setCreateAccessDenied(true)
      setListAccessDenied(true)
    } else if (deniedNewsId) {
      setItemAccessDenied(deniedNewsId)
    } else {
      setListAccessDenied(true)
    }
    void queryClient.cancelQueries({ queryKey: staffNewsKey })
    queryClient.removeQueries({ queryKey: staffNewsKey })
  }
  const listQuery = useInfiniteQuery({
    queryKey: staffNewsKey,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await apiFetch<StaffNewsPageData>(
          `/api/v1/staff/news?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
          {
            authenticated: true,
            signal,
          },
        )
      } catch (error) {
        handleAccessDenied(error, undefined)
        throw error
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !newsId && !isNew && !listAccessDenied,
    staleTime: 0,
  })
  const itemQuery = useQuery({
    queryKey: [...staffNewsKey, newsId],
    queryFn: async ({ signal }) => {
      try {
        return await apiFetch<StaffNews>(`/api/v1/staff/news/${encodeURIComponent(newsId ?? '')}`, {
          authenticated: true,
          signal,
        })
      } catch (error) {
        handleAccessDenied(error, newsId)
        throw error
      }
    },
    enabled: Boolean(newsId) && itemAccessDenied !== newsId,
    staleTime: 0,
  })
  const item = itemQuery.data
  const hasUnsavedChanges = Boolean(
    item &&
    ((titleDraft?.id === newsId && titleDraft?.value !== item.title) ||
      (bodyDraft?.id === newsId && bodyDraft?.value !== item.body)),
  )
  useEffect(() => {
    if (listQuery.isError && isAccessDenied(listQuery.error)) {
      queryClient.removeQueries({ queryKey: staffNewsKey, exact: true })
    }
  }, [listQuery.isError, listQuery.error, queryClient])
  useEffect(() => {
    if (newsId && itemQuery.isError && isAccessDenied(itemQuery.error)) {
      queryClient.removeQueries({ queryKey: [...staffNewsKey, newsId], exact: true })
    }
  }, [newsId, itemQuery.isError, itemQuery.error, queryClient])
  const editorTitle =
    titleDraft && titleDraft.id === newsId ? titleDraft.value : (item?.title ?? '')
  const editorBody = bodyDraft && bodyDraft.id === newsId ? bodyDraft.value : (item?.body ?? '')

  const saveMutation = useMutation({
    throwOnError: false,
    mutationFn: (variables: {
      content: NewsContent
      idempotencyKey: string
      suppressSuccess?: boolean
    }) =>
      requestStaffNews(
        newsId ? `/api/v1/staff/news/${encodeURIComponent(newsId)}` : '/api/v1/staff/news',
        {
          method: newsId ? 'PATCH' : 'POST',
          headers: newsId ? undefined : { 'Idempotency-Key': variables.idempotencyKey },
          body: JSON.stringify(
            newsId
              ? {
                  ...variables.content,
                  version: baseVersion?.id === newsId ? baseVersion.version : item?.version,
                }
              : variables.content,
          ),
        },
      ),
    onError: (error) => handleAccessDenied(error),
    onSuccess: async (news, variables) => {
      if (!newsId) createRequest.current = null
      if (newsId) {
        setBaseVersion({ id: newsId, version: news.version })
        setTitleDraft(null)
        setBodyDraft(null)
      }
      queryClient.setQueryData([...staffNewsKey, news.id], news)
      if (!variables.suppressSuccess)
        setSuccess(news.is_published ? 'Изменения сохранены.' : 'Черновик сохранён.')
      setFeedback(null)
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
    onError: (error) => handleAccessDenied(error),
    onSuccess: async (news) => {
      setBaseVersion({ id: news.id, version: news.version })
      setSuccess(news.is_published ? 'Новость опубликована.' : 'Публикация снята.')
      await queryClient.invalidateQueries({ queryKey: staffNewsKey })
      await queryClient.invalidateQueries({ queryKey: newsFeedKey })
      await queryClient.invalidateQueries({ queryKey: ['news', 'item', news.id] })
      queryClient.setQueryData([...staffNewsKey, news.id], news)
    },
  })
  const isSaving = saveMutation.isPending || publishMutation.isPending

  function clearMutationMessages() {
    setSuccess('')
    setFeedback(null)
    saveMutation.reset()
    publishMutation.reset()
  }

  function getCreateKey(content: NewsContent) {
    const body = JSON.stringify(content)
    if (!createRequest.current || createRequest.current.body !== body) {
      createRequest.current = { body, key: crypto.randomUUID() }
    }
    return createRequest.current.key
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (createAccessDenied) return
    clearMutationMessages()
    const content = { title: editorTitle, body: editorBody }
    saveMutation.mutate({ content, idempotencyKey: getCreateKey(content) })
  }

  if (newsId && itemAccessDenied === newsId)
    return (
      <section className="section-page">
        <ErrorState
          title="Доступ к новости запрещён"
          description="У вас больше нет права публикации новостей."
        />
      </section>
    )
  if (isNew && createAccessDenied)
    return (
      <section className="section-page staff-news-page" aria-labelledby="staff-news-title">
        <p className="section-eyebrow">Рабочее пространство сотрудника</p>
        <h1 id="staff-news-title">Публикация новостей</h1>
        <div className="staff-news-editor">
          <h2>Новая новость</h2>
          <ErrorState
            title="Доступ к созданию новостей запрещён"
            description="Право публикации новостей больше недоступно. Введённый текст оставлен для копирования."
          />
          <label htmlFor="staff-news-title-input">Заголовок</label>
          <input id="staff-news-title-input" value={editorTitle} readOnly />
          <label htmlFor="staff-news-body-input">Текст новости</label>
          <textarea id="staff-news-body-input" value={editorBody} readOnly rows={12} />
        </div>
      </section>
    )
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
          {!listAccessDenied && !isAccessDenied(listQuery.error) && (
            <Link className="staff-news-create" to="/staff/news/new">
              Создать новость
            </Link>
          )}
          {!listAccessDenied && listQuery.isPending && <LoadingState title="Загружаем новости…" />}
          {listAccessDenied && (
            <ErrorState
              title="Доступ к новостям запрещён"
              description="У вас больше нет права публикации новостей."
            />
          )}
          {!listAccessDenied && listQuery.isError && (
            <ErrorState
              title="Не удалось загрузить список"
              description={messageForError(listQuery.error)}
              onRetry={() => void listQuery.refetch()}
            />
          )}
          {!listAccessDenied &&
            !isAccessDenied(listQuery.error) &&
            listQuery.data?.pages[0]?.items.length === 0 && (
              <EmptyState
                title="Новостей пока нет"
                description="Создайте черновик, чтобы подготовить публикацию."
              />
            )}
          {!listAccessDenied &&
            !isAccessDenied(listQuery.error) &&
            !!listQuery.data?.pages.some((page) => page.items.length > 0) && (
              <div className="staff-news-list" aria-label="Список новостей">
                {listQuery.data.pages
                  .flatMap((page) => page.items)
                  .map((news) => (
                    <Link className="staff-news-row" key={news.id} to={`/staff/news/${news.id}`}>
                      <span className="staff-news-row__status">{getNewsStatus(news)}</span>
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
              {item.is_published
                ? `${getNewsStatus(item)} · ${formatDate(item.published_at)}`
                : getNewsStatus(item)}
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
              maxLength={400}
              disabled={isSaving}
              readOnly={createAccessDenied}
              value={editorTitle}
              onChange={(event) => {
                if (codePointLength(event.target.value) > 200) return
                setTitleDraft({ id: newsId, value: event.target.value })
                if (newsId && item && !hasUnsavedChanges)
                  setBaseVersion({ id: newsId, version: item.version })
                clearMutationMessages()
              }}
            />
            <div className="staff-news-editor__counter" aria-live="polite">
              {codePointLength(editorTitle)}/200
            </div>
            <label htmlFor="staff-news-body-input">Текст новости</label>
            <textarea
              id="staff-news-body-input"
              name="body"
              required
              minLength={1}
              maxLength={40_000}
              disabled={isSaving}
              readOnly={createAccessDenied}
              rows={12}
              value={editorBody}
              onChange={(event) => {
                if (codePointLength(event.target.value) > 20_000) return
                setBodyDraft({ id: newsId, value: event.target.value })
                if (newsId && item && !hasUnsavedChanges)
                  setBaseVersion({ id: newsId, version: item.version })
                clearMutationMessages()
              }}
            />
            <div className="staff-news-editor__counter" aria-live="polite">
              {codePointLength(editorBody)}/20 000
            </div>
            {isSaving && (
              <p className="staff-news-feedback" role="status">
                Сохранение выполняется. Поля временно недоступны.
              </p>
            )}
            {(feedback || saveMutation.error || publishMutation.error) && (
              <p className="staff-news-feedback staff-news-feedback--error" role="alert">
                {feedback ?? messageForError(publishMutation.error ?? saveMutation.error)}
              </p>
            )}
            {success && (
              <p className="staff-news-feedback" role="status">
                {success}
              </p>
            )}
            {!createAccessDenied && (
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
                      clearMutationMessages()
                      const content = { title: editorTitle, body: editorBody }
                      try {
                        await saveMutation.mutateAsync({
                          content,
                          idempotencyKey: getCreateKey(content),
                          suppressSuccess: true,
                        })
                      } catch {
                        return
                      }
                      try {
                        await publishMutation.mutateAsync(true)
                      } catch (error) {
                        if (!isAccessDenied(error))
                          setFeedback(
                            `Изменения сохранены, но опубликовать новость не удалось: ${messageForError(error)}`,
                          )
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
                    onClick={() => {
                      clearMutationMessages()
                      publishMutation.mutate(false)
                    }}
                  >
                    Снять с публикации
                  </button>
                )}
              </div>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
