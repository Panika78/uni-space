import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useRoleContext } from '../auth/RoleContext'
import { hasPermission } from '../auth/roleNavigation'
import { updateAcademicStatus } from './statusApi'
import type { AcademicStatus } from './statusApi'
import './staffStudents.css'

type Ref = { id: string; name: string }
type Student = {
  id: string
  full_name: string
  group: Ref
  course_number: number
  program: Ref
  faculty: Ref
  academic_status: AcademicStatus
}
type StudentPage = { items: Student[]; next_cursor: string | null }
type Filters = { faculties: Ref[]; programs: Ref[]; course_numbers: number[] }
const statusLabels: Record<AcademicStatus, string> = {
  enrolled: 'Обучается',
  academic_leave: 'В академическом отпуске',
  expelled: 'Отчислен',
  graduated: 'Выпускник',
}
const statusValues = Object.keys(statusLabels) as AcademicStatus[]
const base = '/api/v1/staff/students'
const readStudent = (id: string, signal: AbortSignal) =>
  apiFetch<Student>(`${base}/${id}`, { authenticated: true, signal })

function StatusEditor({
  studentId,
  student,
  onClose,
  onReadDenied,
}: {
  studentId: string
  student?: Student
  onClose?: () => void
  onReadDenied?: () => void
}) {
  const [target, setTarget] = useState<AcademicStatus | ''>('')
  const [reason, setReason] = useState<'administrative_change' | 'correction'>(
    'administrative_change',
  )
  const [basis, setBasis] = useState(false)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [externalCheck, setExternalCheck] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<AcademicStatus | null>(null)
  const [known, setKnown] = useState(student)
  const [reconciling, setReconciling] = useState(false)
  const [reconciled, setReconciled] = useState(false)
  const [denied, setDenied] = useState(false)
  const alive = useRef(true)
  const request = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const queryClient = useQueryClient()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      request.current?.abort()
    }
  }, [])
  function resetSuccess() {
    setSaved(null)
    setError('')
    setBasis(false)
  }
  async function submit() {
    if (!target || !basis || busy.current || uncertain) return
    busy.current = true
    setPending(true)
    setSaved(null)
    setError('')
    const controller = new AbortController()
    request.current = controller
    try {
      const result = await updateAcademicStatus(studentId, target, reason, controller.signal)
      if (!alive.current) return
      if (result.academic_status !== target) throw new Error('invalid_status_response')
      setSaved(result.academic_status)
      await queryClient.invalidateQueries({ queryKey: ['staff-students'] })
      if (alive.current) onClose?.()
    } catch (cause) {
      if (!alive.current) return
      if (
        cause instanceof ApiClientError &&
        cause.status &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        if (cause.status === 403) {
          setDenied(true)
          setError(
            'Доступ к изменению статуса отозван. Обновите страницу или обратитесь к администратору.',
          )
          void queryClient.invalidateQueries({ queryKey: ['authorization-context'] })
        } else setError('Сервер отклонил изменение. Проверьте ID, статус и основание.')
      } else setUncertain(true)
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }
  async function reconcile() {
    if (!student || reconciling) return
    const controller = new AbortController()
    request.current = controller
    setReconciling(true)
    setError('')
    try {
      const actual = await readStudent(studentId, controller.signal)
      if (!alive.current) return
      if (actual.id !== studentId) throw new Error('invalid_student_response')
      setKnown(actual)
      setReconciled(true)
      await queryClient.invalidateQueries({ queryKey: ['staff-students'] })
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiClientError && cause.status === 403) {
        setDenied(true)
        onReadDenied?.()
      } else setError('Не удалось сверить актуальное состояние. Повторной записи не было.')
    } finally {
      if (alive.current) setReconciling(false)
    }
  }
  if (denied)
    return (
      <>
        <p role="alert">{error || 'Доступ запрещён'}</p>
        {onClose && (
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        )}
      </>
    )
  return (
    <form
      className="student-status-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h2>{student ? 'Изменить академический статус' : 'Изменение статуса по ID'}</h2>
      <p>Студент ID {studentId}</p>
      {known && (
        <>
          <p>
            {known.full_name} · {known.group.name}
          </p>
          <p>Текущий статус: {statusLabels[known.academic_status]}</p>
        </>
      )}
      {!known && <p>Текущий статус неизвестен: право чтения не предоставлено.</p>}
      <label>
        Новый статус
        <select
          aria-label="Новый статус"
          value={target}
          disabled={pending || uncertain}
          required
          onChange={(e) => {
            setTarget(e.target.value as AcademicStatus | '')
            resetSuccess()
          }}
        >
          <option value="">Выберите целевой статус…</option>
          {statusValues.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Основание изменения
        <select
          aria-label="Основание изменения"
          value={reason}
          disabled={pending || uncertain}
          onChange={(e) => {
            setReason(e.target.value as typeof reason)
            resetSuccess()
          }}
        >
          <option value="administrative_change">Оформлено внешнее административное решение</option>
          <option value="correction">Исправление ошибочных данных</option>
        </select>
      </label>
      {target && (
        <p>
          Будет установлен статус: <strong>{statusLabels[target]}</strong>
        </p>
      )}
      <label className="student-basis-confirmation">
        <input
          type="checkbox"
          checked={basis}
          disabled={pending || uncertain}
          onChange={(e) => {
            setBasis(e.target.checked)
            setSaved(null)
          }}
        />
        Подтверждаю, что внешнее основание оформлено
      </label>
      {pending && !saved && (
        <p role="status">
          Запрос отправлен. Закрытие окна не отменяет сохранение; результат ещё не подтверждён.
        </p>
      )}
      {error && (
        <p className="student-form-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p role="status">
          Статус сохранён: {statusLabels[saved]}. Студент ID {studentId}.
        </p>
      )}
      {uncertain && (
        <div role="alert">
          <p>
            Результат изменения неизвестен. Ответ не получен; операция могла быть сохранена.
            Повторной отправки не было.
          </p>
          {student ? (
            <>
              <button type="button" disabled={reconciling} onClick={() => void reconcile()}>
                Сверить актуальное состояние
              </button>
              {reconciled && (
                <p>
                  Показано актуальное состояние на момент сверки. Оно не доказывает исход
                  предыдущего запроса; зависшая операция ещё может завершиться.
                </p>
              )}
            </>
          ) : (
            <p>
              Проверьте результат вне системы через уполномоченного сотрудника. Эта форма не
              предоставляет скрытого чтения.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={externalCheck}
              onChange={(e) => setExternalCheck(e.target.checked)}
            />
            Подтверждаю, что результат предыдущей операции проверен вне системы
          </label>
          <button
            type="button"
            disabled={!externalCheck || reconciling}
            onClick={() => {
              setUncertain(false)
              setExternalCheck(false)
              setReconciled(false)
              setTarget('')
              setBasis(false)
              setSaved(null)
              setError('')
            }}
          >
            Начать новое изменение
          </button>
        </div>
      )}
      <div className="student-form-actions">
        {onClose && (
          <button type="button" className="button-secondary" onClick={onClose}>
            {pending || uncertain ? 'Закрыть окно (результат не подтверждён)' : 'Отмена'}
          </button>
        )}
        <button type="submit" disabled={!target || !basis || pending || uncertain}>
          {pending ? (saved ? 'Обновляем сведения…' : 'Сохраняем…') : 'Подтвердить изменение'}
        </button>
      </div>
    </form>
  )
}

function StatusDialog({
  student,
  trigger,
  onClose,
  onReadDenied,
}: {
  student: Student
  trigger: HTMLElement
  onClose: () => void
  onReadDenied: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '')
    dialog.querySelector<HTMLElement>('select')?.focus()
    return () => {
      if (dialog.close) dialog.close()
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
      else document.querySelector<HTMLElement>('.staff-students-page h1')?.focus()
    }
  }, [trigger])
  return (
    <dialog
      ref={ref}
      className="student-status-dialog"
      aria-modal="true"
      aria-label="Изменение статуса"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        if (e.key === 'Tab') {
          const items = [
            ...ref.current!.querySelectorAll<HTMLElement>(
              'button:not([disabled]),select:not([disabled]),input:not([disabled]),a[href]',
            ),
          ]
          const first = items[0],
            last = items.at(-1)
          if (!first) {
            e.preventDefault()
            ref.current?.focus()
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }}
    >
      <StatusEditor
        studentId={student.id}
        student={student}
        onClose={onClose}
        onReadDenied={onReadDenied}
      />
    </dialog>
  )
}

export function StaffStudentStatusPage() {
  const context = useRoleContext()
  const [studentId, setStudentId] = useState('')
  if (!hasPermission(context, 'students.status.edit'))
    return (
      <ErrorState
        title="Доступ запрещён"
        description="Нет разрешения на изменение академического статуса."
      />
    )
  return (
    <section className="section-page staff-students-page">
      <h1>Изменение академического статуса</h1>
      <p>
        Укажите известный ID студента. Эта форма не выполняет поиск и не показывает персональные
        данные.
      </p>
      <label className="student-id-field">
        ID студента
        <input
          inputMode="numeric"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      {/^[1-9][0-9]*$/.test(studentId) && <StatusEditor key={studentId} studentId={studentId} />}
    </section>
  )
}

function StudentIdentity({ student }: { student: Student }) {
  return (
    <>
      <p>
        {student.group.name} · {student.course_number} курс
      </p>
      <p>
        {student.program.name} · {student.faculty.name}
      </p>
      <p>Академический статус: {statusLabels[student.academic_status]}</p>
    </>
  )
}

export function StaffStudentsPage() {
  const context = useRoleContext()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<{ student: Student; trigger: HTMLElement } | null>(null)
  const [readDenied, setReadDenied] = useState(false)
  const canRead = hasPermission(context, 'students.read'),
    canEdit = hasPermission(context, 'students.status.edit')
  const filters = useQuery({
    queryKey: ['staff-student-filters'],
    queryFn: ({ signal }) => apiFetch<Filters>(`${base}/filters`, { authenticated: true, signal }),
    enabled: canRead,
    gcTime: 0,
  })
  const apiParams = new URLSearchParams()
  for (const name of ['q', 'faculty_id', 'program_id', 'course_number', 'cursor']) {
    const value = params.get(name)
    if (value) apiParams.set(name, value)
  }
  apiParams.set('limit', '20')
  const queryString = apiParams.toString()
  const students = useQuery({
    queryKey: ['staff-students', 'list', queryString],
    queryFn: ({ signal }) =>
      apiFetch<StudentPage>(`${base}?${queryString}`, { authenticated: true, signal }),
    enabled: canRead,
    gcTime: 0,
  })
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    next.delete('cursor')
    next.delete('back')
    if (value) next.set(name, value)
    else next.delete(name)
    setEditing(null)
    setParams(next)
  }
  if (!canRead || readDenied)
    return (
      <ErrorState
        title="Доступ запрещён"
        description="Для поиска требуется разрешение students.read."
      />
    )
  if (filters.isError || students.isError) {
    const forbidden = [filters.error, students.error].some(
      (error) => error instanceof ApiClientError && error.status === 403,
    )
    return (
      <ErrorState
        title={forbidden ? 'Доступ запрещён' : 'Не удалось загрузить студентов'}
        description={
          forbidden
            ? 'Разрешение на поиск было отозвано.'
            : 'Проверьте соединение и повторите попытку.'
        }
        onRetry={
          forbidden
            ? undefined
            : () => {
                void filters.refetch()
                void students.refetch()
              }
        }
      />
    )
  }
  if (filters.isPending) return <LoadingState title="Загружаем студентов…" />
  const nextCursor = students.data?.next_cursor
  const back = params.getAll('back')
  return (
    <section className="section-page staff-students-page">
      <h1 tabIndex={-1}>Поиск студентов</h1>
      <form
        className="staff-student-filters"
        onSubmit={(e) => {
          e.preventDefault()
          filter('q', String(new FormData(e.currentTarget).get('q') ?? '').trim())
        }}
      >
        <label>
          ФИО или группа
          <input
            key={params.get('q') ?? ''}
            name="q"
            defaultValue={params.get('q') ?? ''}
            placeholder="Например, Иванова или ИВТ-21"
          />
        </label>
        {[
          {
            name: 'faculty_id',
            label: 'Факультет',
            empty: 'Все факультеты',
            items: filters.data.faculties,
          },
          {
            name: 'program_id',
            label: 'Программа',
            empty: 'Все программы',
            items: filters.data.programs,
          },
          {
            name: 'course_number',
            label: 'Курс',
            empty: 'Все курсы',
            items: filters.data.course_numbers.map((n) => ({ id: String(n), name: String(n) })),
          },
        ].map((field) => (
          <label key={field.name}>
            {field.label}
            <select
              aria-label={field.label}
              value={params.get(field.name) ?? ''}
              onChange={(e) => filter(field.name, e.target.value)}
            >
              <option value="">{field.empty}</option>
              {field.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button type="submit">Найти</button>
      </form>
      {canEdit && <Link to="/staff/students/status">Изменить статус по известному ID</Link>}
      {students.isPending ? (
        <LoadingState title="Загружаем студентов…" />
      ) : !students.data?.items.length ? (
        <p>Студенты не найдены. Измените запрос или фильтры.</p>
      ) : (
        <div className="staff-students-list">
          {students.data?.items.map((student) => (
            <article className="staff-student-card" key={student.id} data-student-id={student.id}>
              <div>
                <h2>
                  <Link to={`/staff/students/${student.id}?${params.toString()}`}>
                    {student.full_name}
                  </Link>
                </h2>
                <StudentIdentity student={student} />
              </div>
              <div className="staff-student-status">
                {canEdit && (
                  <button
                    type="button"
                    onClick={(e) => setEditing({ student, trigger: e.currentTarget })}
                  >
                    Изменить статус
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <nav aria-label="Страницы студентов">
        <p>Страница {back.length + 1}</p>
        {back.length > 0 && (
          <button
            type="button"
            className="student-next-page"
            onClick={() => {
              const next = new URLSearchParams(params)
              const previous = back.at(-1)!
              next.delete('back')
              back.slice(0, -1).forEach((value) => next.append('back', value))
              if (previous) next.set('cursor', previous)
              else next.delete('cursor')
              setParams(next)
            }}
          >
            Предыдущие 20
          </button>
        )}
        {nextCursor && (
          <button
            type="button"
            className="student-next-page"
            onClick={() => {
              const next = new URLSearchParams(params)
              next.append('back', params.get('cursor') ?? '')
              if (!nextCursor) return
              next.set('cursor', nextCursor)
              setParams(next)
            }}
          >
            Следующие 20
          </button>
        )}
      </nav>
      {editing && canEdit && (
        <StatusDialog
          key={editing.student.id}
          {...editing}
          onClose={() => setEditing(null)}
          onReadDenied={() => setReadDenied(true)}
        />
      )}
    </section>
  )
}

export function StaffStudentDetailPage() {
  const { id } = useParams()
  return <StaffStudentDetailContent key={id} id={id!} />
}

function StaffStudentDetailContent({ id }: { id: string }) {
  const [params] = useSearchParams()
  const context = useRoleContext()
  const canRead = hasPermission(context, 'students.read'),
    canEdit = hasPermission(context, 'students.status.edit')
  const [editing, setEditing] = useState<HTMLElement | null>(null)
  const [readDenied, setReadDenied] = useState(false)
  const query = useQuery({
    queryKey: ['staff-students', 'detail', id],
    queryFn: ({ signal }) => readStudent(id, signal),
    enabled: canRead,
    gcTime: 0,
  })
  if (!canRead || readDenied)
    return (
      <ErrorState title="Доступ запрещён" description="Для просмотра требуется students.read." />
    )
  if (query.isError) {
    const status = query.error instanceof ApiClientError ? query.error.status : null
    return (
      <ErrorState
        title={
          status === 403
            ? 'Доступ запрещён'
            : status === 404
              ? 'Студент не найден'
              : 'Не удалось загрузить студента'
        }
        description="Карточка недоступна."
        onRetry={status === 403 || status === 404 ? undefined : () => void query.refetch()}
      />
    )
  }
  if (query.isPending) return <LoadingState title="Загружаем карточку…" />
  const student = query.data
  return (
    <section className="section-page staff-students-page">
      <h1 tabIndex={-1}>{student.full_name}</h1>
      <StudentIdentity student={student} />
      <Link to={`/staff/students?${params.toString()}`}>К результатам поиска</Link>
      {canEdit && (
        <button type="button" onClick={(e) => setEditing(e.currentTarget)}>
          Изменить статус
        </button>
      )}
      {editing && canEdit && (
        <StatusDialog
          key={student.id}
          student={student}
          trigger={editing}
          onClose={() => setEditing(null)}
          onReadDenied={() => setReadDenied(true)}
        />
      )}
    </section>
  )
}
