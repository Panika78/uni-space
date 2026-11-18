import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiClientError, isDefinitiveApiRejection } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { SaveLabel, statuses, type SaveState } from '../teacher/journalControls'
import {
  isAccessError,
  journalError,
  journalRequest,
  pageUrl,
  staffJournal,
  type JournalAccess,
  type Page,
} from './journalQueries'

type Schema = components['schemas']
type StudentRow = { student_id: string }
type Compare<T> = (row: T | undefined) => boolean

function useRowSave<T extends StudentRow>(
  access: JournalAccess,
  readPath: string,
  studentId: string,
) {
  const client = useQueryClient()
  const [state, setState] = useState<SaveState>()
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])

  async function save(
    path: string,
    init: RequestInit,
    matches: Compare<T>,
    onConfirmed?: () => void,
    checkOnly = false,
  ) {
    if (active.current && !active.current.signal.aborted) return
    const controller = new AbortController()
    active.current = controller
    const signal = controller.signal
    setState({ phase: 'saving' })
    const refresh = () => client.invalidateQueries({ queryKey: ['staff-journal', ...access] })
    async function readCurrent() {
      if (!readPath.startsWith('/api/v1/final-results/')) {
        const page = await journalRequest<Page<T>>(
          pageUrl(readPath, null, { student_id: studentId }),
          { signal },
        )
        return page.items[0]
      }
      try {
        return await journalRequest<T>(readPath, { signal })
      } catch (error) {
        if (init.method !== 'DELETE' || !(error instanceof ApiClientError) || error.status !== 404)
          throw error
        // A transferred student without a saved final is outside the write API's read scope.
        const coursePath = readPath
          .split('/students/')[0]
          .replace('/api/v1/final-results', staffJournal)
        const page = await journalRequest<Page<Schema['HistoricalFinalStudent']>>(
          pageUrl(`${coursePath}/historical-final-students`, null, { student_id: studentId }),
          { signal },
        )
        if (page.items[0]?.history_only) return undefined
        throw error
      }
    }
    async function verify() {
      const actual = await readCurrent()
      if (signal.aborted) return
      const verified = matches(actual)
      await refresh()
      if (signal.aborted) return
      if (verified) onConfirmed?.()
      setState(
        verified
          ? { phase: 'saved' }
          : {
              phase: 'error',
              message: 'Сервер вернул другое значение. Повторите сохранение при необходимости.',
              retry: () => void save(path, init, matches, onConfirmed),
            },
      )
    }
    try {
      if (checkOnly) {
        await verify()
      } else {
        await journalRequest(path, { ...init, signal, replayAfterRefresh: false })
        if (signal.aborted) return
        await refresh()
        if (signal.aborted) return
        onConfirmed?.()
        setState({ phase: 'saved' })
      }
    } catch (error) {
      if (signal.aborted) return
      if (isAccessError(error)) {
        void client.invalidateQueries({ queryKey: ['authorization-context'] })
        void refresh()
        setState({ phase: 'error', message: journalError(error) })
        return
      }
      const uncertain = checkOnly || !isDefinitiveApiRejection(error)
      if (uncertain && !checkOnly) {
        try {
          await verify()
          return
        } catch (readError) {
          if (signal.aborted) return
          if (isAccessError(readError)) {
            void client.invalidateQueries({ queryKey: ['authorization-context'] })
            void refresh()
          }
        }
      }
      setState({
        phase: 'error',
        uncertain,
        message: uncertain
          ? `${journalError(error)} Сохранение не подтверждено.`
          : journalError(error),
        retry: () => void save(path, init, matches, onConfirmed, uncertain),
      })
      if (error instanceof ApiClientError && [404, 409].includes(error.status ?? 0)) void refresh()
    } finally {
      if (active.current === controller) active.current = null
    }
  }
  return {
    save,
    state,
    reset: () => setState(undefined),
    busy: state?.phase === 'saving' || state?.uncertain === true,
  }
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
}

export function ScoreRow({
  row,
  assessment,
  group,
  access,
  readPath,
  onHistory,
}: {
  row: Schema['StaffScoreRow']
  assessment: Schema['JournalAssessment']
  group: string
  access: JournalAccess
  readPath: string
  onHistory: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [validation, setValidation] = useState('')
  const save = useRowSave<Schema['StaffScoreRow']>(access, readPath, row.student_id)
  const path = `/api/v1/teaching/courses/${group}/assessments/${assessment.id}/results/${row.student_id}`
  function submit() {
    if (!row.can_edit || save.busy || draft === null) return
    const input = draft.trim()
    const value = input === '' ? null : Number(input)
    if (value !== null && (!/^\d+$/.test(input) || value > assessment.max_score)) {
      setValidation(`Введите целое число от 0 до ${assessment.max_score}.`)
      return
    }
    if (value === row.score) return
    void save.save(
      path,
      json('PUT', { score: value }),
      (actual) => actual?.score === value,
      () => setDraft(null),
    )
  }
  return (
    <article className="journal-student">
      <div className="journal-student__identity">
        <strong>{row.full_name}</strong>
        {row.history_only ? (
          <small>Оценка удалена</small>
        ) : (
          !row.is_current_group_member && <small>Историческая оценка</small>
        )}
        <button type="button" className="journal-inline-action" onClick={onHistory}>
          История изменений
        </button>
      </div>
      <label className="journal-score">
        Балл из {assessment.max_score}
        <input
          inputMode="numeric"
          value={draft ?? String(row.score ?? '')}
          aria-label={`Балл · ${row.full_name}`}
          aria-invalid={Boolean(validation)}
          disabled={!row.can_edit}
          readOnly={save.busy}
          onChange={(event) => {
            setDraft(event.target.value)
            setValidation('')
            save.reset()
          }}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </label>
      {validation && <span role="alert">{validation}</span>}
      <SaveLabel state={save.state} onRetry={save.state?.retry} />
    </article>
  )
}

export function AttendanceRow({
  row,
  lessonId,
  access,
  readPath,
}: {
  row: Schema['StaffAttendanceRow']
  lessonId: string
  access: JournalAccess
  readPath: string
}) {
  const save = useRowSave<Schema['StaffAttendanceRow']>(access, readPath, row.student_id)
  const path = `/api/v1/attendance/lessons/${lessonId}/students/${row.student_id}`
  return (
    <article className="journal-student">
      <div className="journal-student__identity">
        <strong>{row.full_name}</strong>
        {row.is_historical && <small>Историческая отметка</small>}
      </div>
      <div
        className="journal-attendance-controls"
        role="group"
        aria-label={`Посещаемость · ${row.full_name}`}
      >
        {statuses.map(({ value, label, title }) => (
          <button
            type="button"
            key={value}
            aria-pressed={row.status === value}
            aria-label={title}
            title={title}
            disabled={!row.can_edit || save.busy}
            onClick={() => {
              if (row.status === value) return
              void save.save(
                path,
                value === 'unmarked' ? { method: 'DELETE' } : json('PUT', { status: value }),
                (actual) => actual?.status === value || (value === 'unmarked' && !actual),
              )
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <SaveLabel state={save.state} onRetry={save.state?.retry} />
    </article>
  )
}

export type Final = Schema['ManualFinalResultResponse']
type Attestation = NonNullable<Schema['StaffCatalogItem']['attestation_type']>

export function FinalRow({
  row,
  fullName,
  attestation,
  access,
  readPath,
  onHistory,
}: {
  row: Final
  fullName: string
  attestation: Attestation
  access: JournalAccess
  readPath: string
  onHistory: () => void
}) {
  const [grade, setGrade] = useState<string>()
  const [date, setDate] = useState<string>()
  const [location, setLocation] = useState<string>()
  const save = useRowSave<Final>(access, readPath, row.student_id)
  const isPass = attestation === 'pass_fail'
  const path = `/api/v1/final-results/courses/${row.course_offering_id}/students/${row.student_id}`
  const gradeValue = grade ?? String((isPass ? row.passed : row.grade_value) ?? '')
  function submit(remove = false) {
    const patch = {
      grade_value: isPass || gradeValue === '' ? null : Number(gradeValue),
      passed: isPass && gradeValue !== '' ? gradeValue === 'true' : null,
      retake_date: (date ?? row.retake_date) || null,
      retake_location: (location ?? row.retake_location)?.trim() || null,
    }
    const clearsRetake = remove || patch.passed || (patch.grade_value ?? 0) >= 3
    const matches: Compare<Final> = (actual) => {
      if (remove) return !actual?.result_id
      return (
        actual?.grade_value === patch.grade_value &&
        actual?.passed === patch.passed &&
        actual?.retake_date === (clearsRetake ? null : patch.retake_date) &&
        actual?.retake_location === (clearsRetake ? null : patch.retake_location)
      )
    }
    void save.save(path, remove ? { method: 'DELETE' } : json('PATCH', patch), matches, () => {
      setDate(undefined)
      setLocation(undefined)
      setGrade(undefined)
    })
  }
  return (
    <article className="journal-student journal-student--final">
      <div className="journal-student__identity">
        <strong>{fullName}</strong>
        <button type="button" className="journal-inline-action" onClick={onHistory}>
          История изменений
        </button>
      </div>
      <form
        className="journal-retake-fields"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="journal-score">
          Итог
          <select
            value={gradeValue}
            onChange={(event) => {
              setGrade(event.target.value)
              save.reset()
            }}
            disabled={save.busy}
          >
            <option value="">Не выставлен</option>
            {isPass ? (
              <>
                <option value="true">Зачтено</option>
                <option value="false">Не зачтено</option>
              </>
            ) : (
              [2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          Дата пересдачи
          <input
            type="date"
            value={date ?? row.retake_date ?? ''}
            readOnly={save.busy}
            onChange={(event) => {
              setDate(event.target.value)
              save.reset()
            }}
          />
        </label>
        <label>
          Место пересдачи
          <input
            value={location ?? row.retake_location ?? ''}
            maxLength={200}
            readOnly={save.busy}
            onChange={(event) => {
              setLocation(event.target.value)
              save.reset()
            }}
          />
        </label>
        <div className="staff-journal-actions">
          <button type="submit" disabled={save.busy}>
            Сохранить итог
          </button>
          <button type="button" disabled={save.busy || !row.result_id} onClick={() => submit(true)}>
            Удалить итог
          </button>
        </div>
      </form>
      <SaveLabel state={save.state} onRetry={save.state?.retry} />
    </article>
  )
}
