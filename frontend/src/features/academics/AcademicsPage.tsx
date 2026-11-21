import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useStudentReadScope } from '../profile/profileContext'
import { getStudentRead } from '../profile/studentReads'
import { CourseLink, useCourseReturnPosition } from './CourseLink'
import './academics.css'

type Academics = components['schemas']['AcademicsResponse']
type Item = Academics['items'][number]
export const attestationLabels = {
  exam: 'Экзамен',
  pass_fail: 'Зачёт',
  graded_pass: 'Дифференцированный зачёт',
}
const gradeLabels = {
  5: 'Отлично',
  4: 'Хорошо',
  3: 'Удовлетворительно',
  2: 'Неудовлетворительно',
}

function getResultLabel(item: Item) {
  const result = item.final_result
  if (result.grade_value !== null) return gradeLabels[result.grade_value]
  if (result.passed !== null) return result.passed ? 'Зачтено' : 'Не зачтено'
  return 'Не выставлено'
}

export function SessionResult({ item }: { item: Item }) {
  const result = item.final_result
  const hasResult = result.grade_value !== null || result.passed !== null
  return (
    <div className="academics-result">
      <span
        className={`academics-label academics-label--${result.has_debt ? 'debt' : hasResult ? 'complete' : 'pending'}`}
      >
        {getResultLabel(item)}
      </span>
      {result.has_debt && <p className="academics-debt">Задолженность</p>}
      {(result.retake_date || result.retake_location) && (
        <p className="academics-retake">
          Пересдача
          {result.retake_date && (
            <>
              {' '}
              ·{' '}
              <time dateTime={result.retake_date}>
                {new Intl.DateTimeFormat('ru-RU', {
                  dateStyle: 'long',
                  timeZone: 'Europe/Moscow',
                }).format(new Date(`${result.retake_date}T12:00:00Z`))}
              </time>
            </>
          )}
          {result.retake_location && <> · {result.retake_location}</>}
        </p>
      )}
    </div>
  )
}

export function AcademicsPage() {
  const access = useStudentReadScope()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['academics', ...(access?.scope.key ?? [])],
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
    queryFn: ({ signal }) =>
      getStudentRead<Academics>('/api/v1/academics', signal, access?.scope ?? null),
  })
  const scopeChanged =
    query.error instanceof ApiClientError && query.error.code === 'student_scope_changed'
  useEffect(() => {
    if (scopeChanged) void client.invalidateQueries({ queryKey: ['student-profile'] })
  }, [client, scopeChanged])
  const isLoading = query.isPending || access?.isChecking
  useCourseReturnPosition(query.isSuccess && !isLoading)
  const status = query.error instanceof ApiClientError ? query.error.status : null
  return (
    <section className="section-page academics-page" aria-labelledby="academics-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="academics-title" tabIndex={-1}>
        Успеваемость
      </h1>
      {isLoading && <LoadingState title="Загружаем успеваемость…" />}
      {!isLoading && query.isError && (
        <ErrorState
          title={
            status === 403
              ? 'Успеваемость недоступна'
              : status === 401
                ? 'Войдите в аккаунт заново'
                : 'Не удалось загрузить успеваемость'
          }
          description={
            status === 403
              ? 'Просмотр доступен только студенту.'
              : status === 401
                ? 'Сессия завершена.'
                : 'Попробуйте загрузить данные ещё раз.'
          }
          onRetry={status === 401 || status === 403 ? undefined : () => void query.refetch()}
        />
      )}
      {!isLoading && !query.isError && query.data && (
        <>
          {query.data.term && <p className="academics-term">{query.data.term.name}</p>}
          {!query.data.term ? (
            <EmptyState
              title="Нет текущего учебного периода"
              description="Успеваемость появится после начала учебного периода."
            />
          ) : query.data.items.length === 0 ? (
            <EmptyState
              title="Нет дисциплин текущего семестра"
              description="Дисциплины появятся после назначения вашей группе."
            />
          ) : (
            <>
              <section aria-labelledby="disciplines-title">
                <h2 id="disciplines-title">Текущие дисциплины</h2>
                <table
                  className="academics-table academics-table--courses"
                  role="table"
                  aria-labelledby="disciplines-title"
                >
                  <thead role="rowgroup">
                    <tr role="row">
                      <th scope="col" role="columnheader">
                        Дисциплина
                      </th>
                      <th scope="col" role="columnheader">
                        Баллы
                      </th>
                      <th scope="col" role="columnheader">
                        Оценено работ
                      </th>
                      <th scope="col" role="columnheader">
                        Детали
                      </th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {query.data.items.map((item) => (
                      <tr key={item.course_offering_id} role="row">
                        <th scope="row" role="rowheader">
                          <span className="academics-desktop-course-name">
                            {item.discipline.name}
                          </span>
                          <CourseLink
                            className="academics-mobile-course-link"
                            aria-label={`Страница дисциплины «${item.discipline.name}»`}
                            courseId={item.course_offering_id}
                            data-course-id={item.course_offering_id}
                            returnSelector={`[data-course-id="${item.course_offering_id}"]`}
                          >
                            {item.discipline.name}
                          </CourseLink>
                        </th>
                        <td role="cell">
                          <span className="academics-mobile-label" aria-hidden="true">
                            Баллы
                          </span>
                          <strong>
                            {item.total_score} / {item.max_score}
                          </strong>
                          {item.assessment_count === 0 ? (
                            <small>Нет работ</small>
                          ) : (
                            item.graded_assessment_count === 0 && <small>Не выставлено</small>
                          )}
                        </td>
                        <td role="cell">
                          <span className="academics-mobile-label" aria-hidden="true">
                            Оценено работ
                          </span>
                          {item.graded_assessment_count} из {item.assessment_count}
                        </td>
                        <td role="cell">
                          <span className="academics-mobile-label" aria-hidden="true">
                            Детали
                          </span>
                          <CourseLink
                            className="academics-course-link"
                            aria-label={`Открыть дисциплину «${item.discipline.name}»`}
                            courseId={item.course_offering_id}
                            data-course-id={item.course_offering_id}
                            returnSelector={`[data-course-id="${item.course_offering_id}"]`}
                          >
                            Открыть дисциплину <span aria-hidden="true">→</span>
                          </CourseLink>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="academics-session" aria-labelledby="session-title">
                <h2 id="session-title">Сессия</h2>
                <table className="academics-table" role="table" aria-labelledby="session-title">
                  <thead role="rowgroup">
                    <tr role="row">
                      <th scope="col" role="columnheader">
                        Дисциплина
                      </th>
                      <th scope="col" role="columnheader">
                        Аттестация
                      </th>
                      <th scope="col" role="columnheader">
                        Результат
                      </th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {query.data.items.map((item) => (
                      <tr key={item.course_offering_id} role="row">
                        <th scope="row" role="rowheader">
                          {item.discipline.name}
                        </th>
                        <td role="cell">
                          <span className="academics-mobile-label" aria-hidden="true">
                            Аттестация
                          </span>
                          {attestationLabels[item.attestation_type]}
                        </td>
                        <td role="cell">
                          <span className="academics-mobile-label" aria-hidden="true">
                            Результат
                          </span>
                          <SessionResult item={item} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </section>
  )
}
