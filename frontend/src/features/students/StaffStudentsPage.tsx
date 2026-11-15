import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useRoleContext } from '../auth/RoleContext'
import { hasPermission } from '../auth/roleNavigation'
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
type AcademicStatus = 'enrolled' | 'academic_leave' | 'expelled' | 'graduated'
type StudentPage = { items: Student[]; next_cursor: string | null }
type Filters = { faculties: Ref[]; programs: Ref[]; course_numbers: number[] }

const statusLabels: Record<AcademicStatus, string> = {
  enrolled: 'Обучается',
  academic_leave: 'В академическом отпуске',
  expelled: 'Отчислен',
  graduated: 'Выпускник',
}
const statusValues = Object.keys(statusLabels) as AcademicStatus[]

function StatusEditor({
  studentId,
  currentStatus,
  onClose,
}: {
  studentId: string
  currentStatus?: AcademicStatus
  onClose?: () => void
}) {
  const [academicStatus, setAcademicStatus] = useState<AcademicStatus>(currentStatus ?? 'enrolled')
  const [reason, setReason] = useState<'administrative_change' | 'correction'>(
    'administrative_change',
  )
  const [basisConfirmed, setBasisConfirmed] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<{ academic_status: AcademicStatus }>(
        `/api/v1/staff/students/${studentId}/academic-status`,
        {
          method: 'PUT',
          authenticated: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ academic_status: academicStatus, reason }),
        },
      ),
    onSuccess: async () => {
      setError('')
      await queryClient.invalidateQueries({ queryKey: ['staff-students'] })
      onClose?.()
    },
    onError: (cause) => {
      if (cause instanceof ApiClientError && cause.status === 403) {
        setError(
          'Доступ к изменению статуса отозван. Обновите страницу или обратитесь к администратору.',
        )
      } else {
        setError('Не удалось сохранить статус. Повторите попытку.')
      }
    },
  })

  return (
    <form
      className="student-status-form"
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        mutation.mutate()
      }}
    >
      <h2>{currentStatus ? 'Изменить академический статус' : 'Изменение статуса по ID'}</h2>
      <p>Студент ID {studentId}</p>
      {currentStatus && <p>Текущий статус: {statusLabels[currentStatus]}</p>}
      <label>
        Новый статус
        <select
          value={academicStatus}
          onChange={(event) => setAcademicStatus(event.target.value as AcademicStatus)}
        >
          {statusValues.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Основание изменения
        <select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
          <option value="administrative_change">Оформлено внешнее административное решение</option>
          <option value="correction">Исправление ошибочных данных</option>
        </select>
      </label>
      <label className="student-basis-confirmation">
        <input
          type="checkbox"
          checked={basisConfirmed}
          onChange={(event) => setBasisConfirmed(event.target.checked)}
        />
        Подтверждаю, что внешнее основание оформлено
      </label>
      {error && (
        <p className="student-form-error" role="alert">
          {error}
        </p>
      )}
      {mutation.isSuccess && <p role="status">Статус сохранён.</p>}
      <div className="student-form-actions">
        {onClose && (
          <button type="button" className="button-secondary" onClick={onClose}>
            Отмена
          </button>
        )}
        <button type="submit" disabled={!basisConfirmed || mutation.isPending}>
          {mutation.isPending ? 'Сохраняем…' : 'Подтвердить изменение'}
        </button>
      </div>
    </form>
  )
}

export function StaffStudentStatusPage() {
  const context = useRoleContext()
  const [studentId, setStudentId] = useState('')
  const allowed = hasPermission(context, 'students.status.edit')
  if (!allowed)
    return (
      <ErrorState
        title="Доступ запрещён"
        description="Нет разрешения на изменение академического статуса."
      />
    )
  return (
    <section className="section-page staff-students-page">
      <p className="section-eyebrow">Сотрудникам</p>
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
          onChange={(event) => setStudentId(event.target.value.replace(/\D/g, ''))}
        />
      </label>
      {studentId && /^[1-9][0-9]*$/.test(studentId) && (
        <StatusEditor key={studentId} studentId={studentId} />
      )}
    </section>
  )
}

export function StaffStudentsPage() {
  const context = useRoleContext()
  const [search, setSearch] = useState('')
  const [queryText, setQueryText] = useState('')
  const [facultyId, setFacultyId] = useState('')
  const [programId, setProgramId] = useState('')
  const [courseNumber, setCourseNumber] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [editing, setEditing] = useState<Student | null>(null)
  const canRead = hasPermission(context, 'students.read')
  const canEdit = hasPermission(context, 'students.status.edit')
  const filters = useQuery({
    queryKey: ['staff-student-filters'],
    queryFn: ({ signal }) =>
      apiFetch<Filters>('/api/v1/staff/students/filters', { authenticated: true, signal }),
    enabled: canRead,
  })
  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (queryText) params.set('q', queryText)
    if (facultyId) params.set('faculty_id', facultyId)
    if (programId) params.set('program_id', programId)
    if (courseNumber) params.set('course_number', courseNumber)
    if (cursor) params.set('cursor', cursor)
    params.set('limit', '20')
    return params.toString()
  }, [queryText, facultyId, programId, courseNumber, cursor])
  const students = useQuery({
    queryKey: ['staff-students', queryString],
    queryFn: ({ signal }) =>
      apiFetch<StudentPage>(`/api/v1/staff/students?${queryString}`, {
        authenticated: true,
        signal,
      }),
    enabled: canRead,
  })
  if (!canRead)
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
  if (filters.isPending || students.isPending) return <LoadingState title="Загружаем студентов…" />

  return (
    <section className="section-page staff-students-page">
      <p className="section-eyebrow">Сотрудникам</p>
      <h1>Поиск студентов</h1>
      <form
        className="staff-student-filters"
        onSubmit={(event) => {
          event.preventDefault()
          setCursor(null)
          setQueryText(search.trim())
        }}
      >
        <label>
          ФИО или группа
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Например, Иванова или ИВТ-21"
          />
        </label>
        <label>
          Факультет
          <select
            value={facultyId}
            onChange={(event) => {
              setFacultyId(event.target.value)
              setCursor(null)
            }}
          >
            <option value="">Все факультеты</option>
            {filters.data.faculties.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Программа
          <select
            value={programId}
            onChange={(event) => {
              setProgramId(event.target.value)
              setCursor(null)
            }}
          >
            <option value="">Все программы</option>
            {filters.data.programs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Курс
          <select
            value={courseNumber}
            onChange={(event) => {
              setCourseNumber(event.target.value)
              setCursor(null)
            }}
          >
            <option value="">Все курсы</option>
            {filters.data.course_numbers.map((course) => (
              <option key={course} value={course}>
                {course}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Найти</button>
      </form>
      {canEdit && (
        <p className="staff-status-link">
          <Link to="/staff/students/status">Изменить статус по известному ID</Link>
        </p>
      )}
      {!students.data.items.length ? (
        <p className="staff-students-empty">Студенты не найдены. Измените запрос или фильтры.</p>
      ) : (
        <div className="staff-students-list">
          {students.data.items.map((student) => (
            <article className="staff-student-card" key={student.id}>
              <div>
                <h2>{student.full_name}</h2>
                <p>
                  {student.group.name} · {student.course_number} курс
                </p>
                <p>
                  {student.program.name} · {student.faculty.name}
                </p>
              </div>
              <div className="staff-student-status">
                <span>{statusLabels[student.academic_status]}</span>
                {canEdit && (
                  <button type="button" onClick={() => setEditing(student)}>
                    Изменить статус
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {students.data.next_cursor && (
        <button
          className="student-next-page"
          type="button"
          onClick={() => setCursor(students.data.next_cursor)}
        >
          Следующие 20
        </button>
      )}
      {editing && (
        <div className="student-status-overlay" role="presentation">
          <div
            className="student-status-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Изменение статуса"
          >
            <StatusEditor
              studentId={editing.id}
              currentStatus={editing.academic_status}
              onClose={() => setEditing(null)}
            />
          </div>
        </div>
      )}
    </section>
  )
}
