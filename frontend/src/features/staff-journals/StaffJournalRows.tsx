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
import { useJournalEdit, type Operation, type Values } from './JournalEdits'

function finalBaseline(row: Values | undefined) {
  return JSON.stringify([
    row?.result_id ?? null,
    row?.grade_value ?? null,
    row?.passed ?? null,
    row?.retake_date ?? null,
    row?.retake_location ?? null,
  ])
}

function useRowSave(access: JournalAccess, readPath: string, studentId: string, path: string) {
  const client = useQueryClient()
  const { entry, update, active } = useJournalEdit(path)
  const busy = entry.phase === 'saving' || entry.phase === 'uncertain'

  async function save(operation: Operation, mode: 'write' | 'retry' | 'verify' = 'write') {
    if (active.has(path)) return
    const controller = new AbortController()
    active.set(path, controller)
    const signal = controller.signal
    const target = operation.readPath ?? readPath
    update((old) => ({
      ...old,
      operation: { ...operation, readPath: target },
      phase: 'saving',
      message: undefined,
    }))
    const refresh = () => client.invalidateQueries({ queryKey: ['staff-journal', ...access] })

    async function readCurrent(): Promise<Values | undefined> {
      if (!target.startsWith('/api/v1/final-results/')) {
        const page = await journalRequest<Page<Values>>(
          pageUrl(target, null, { student_id: studentId }),
          { signal },
        )
        return page.items[0]
      }
      try {
        return await journalRequest<Values>(target, { signal })
      } catch (error) {
        if (
          operation.method !== 'DELETE' ||
          !(error instanceof ApiClientError) ||
          error.status !== 404
        )
          throw error
        const coursePath = target
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

    async function finish(confirmed: boolean) {
      if (signal.aborted) return
      await refresh()
      if (signal.aborted) return
      active.delete(path)
      update((old) =>
        confirmed
          ? { phase: 'saved' }
          : {
              ...old,
              phase: 'error',
              message: 'Сервер вернул другое значение. Повторите сохранение при необходимости.',
            },
      )
    }

    const matches = (actual: Values | undefined) =>
      Object.entries(operation.expected).every(
        ([key, value]) => (actual?.[key] ?? (key === 'status' ? 'unmarked' : null)) === value,
      )
    async function verify() {
      await finish(matches(await readCurrent()))
    }

    function deny() {
      active.delete(path)
      update(() => ({ phase: 'error', message: 'Доступ к сохранению изменился.' }))
      void client.invalidateQueries({ queryKey: ['authorization-context'] })
      void refresh()
    }

    try {
      if (mode === 'verify') {
        await verify()
        return
      }
      if (mode === 'retry' || entry.baseline !== undefined) {
        const actual = await readCurrent()
        if (signal.aborted) return
        if (mode === 'retry' && matches(actual)) {
          await finish(true)
          return
        }
        if (entry.baseline !== undefined && finalBaseline(actual) !== entry.baseline) {
          await finish(false)
          return
        }
      }
      await journalRequest(path, {
        signal,
        replayAfterRefresh: false,
        method: operation.method,
        ...(operation.body && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(operation.body),
        }),
      })
      await finish(true)
    } catch (error) {
      if (signal.aborted) return
      if (isAccessError(error)) {
        deny()
        return
      }
      const uncertain = mode === 'verify' || !isDefinitiveApiRejection(error)
      if (uncertain && mode !== 'verify') {
        try {
          await verify()
          return
        } catch (readError) {
          if (signal.aborted) return
          if (isAccessError(readError)) {
            deny()
            return
          }
        }
      }
      active.delete(path)
      update((old) => ({
        ...old,
        phase: uncertain ? 'uncertain' : 'error',
        message: uncertain
          ? `${journalError(error)} Сохранение не подтверждено.`
          : journalError(error),
      }))
      if (error instanceof ApiClientError && [404, 409].includes(error.status ?? 0)) void refresh()
    } finally {
      if (active.get(path) === controller) active.delete(path)
    }
  }

  const state: SaveState | undefined = entry.phase && {
    phase: entry.phase === 'uncertain' ? 'error' : entry.phase,
    uncertain: entry.phase === 'uncertain',
    message:
      entry.message ?? (entry.phase === 'uncertain' ? 'Сохранение не подтверждено.' : undefined),
    retry:
      entry.operation && entry.phase !== 'saving'
        ? () => void save(entry.operation!, entry.phase === 'uncertain' ? 'verify' : 'retry')
        : undefined,
  }
  return {
    save,
    entry,
    state,
    busy,
    change: (field: string, value: string, baseline?: string, initial?: Record<string, string>) => {
      if (active.has(path) || entry.phase === 'uncertain') return
      update((old) => ({
        draft: { ...(old.draft ?? initial), [field]: value },
        baseline: old.baseline ?? baseline,
      }))
    },
    discardDraft: () => update(() => ({})),
    discardRetakeDraft: (confirmedGrade: string) =>
      update((old) => {
        if (!old.draft) return old
        const { grade } = old.draft
        const hasGradeDraft = grade !== undefined && grade !== confirmedGrade
        return {
          ...old,
          draft: hasGradeDraft ? { grade } : undefined,
          baseline: hasGradeDraft ? old.baseline : undefined,
        }
      }),
    acceptBaseline: (baseline: string) => update((old) => ({ draft: old.draft, baseline })),
  }
}

export function ScoreRow({
  row,
  assessment,
  group,
  access,
  readPath,
  onHistory,
  display = 'card',
}: {
  row: Schema['StaffScoreRow']
  assessment: Schema['JournalAssessment']
  group: string
  access: JournalAccess
  readPath: string
  onHistory: () => void
  display?: 'card' | 'table-row'
}) {
  const [validation, setValidation] = useState('')
  const path = `/api/v1/teaching/courses/${group}/assessments/${assessment.id}/results/${row.student_id}`
  const save = useRowSave(access, readPath, row.student_id, path)
  const draft = save.entry.draft?.score
  function submit() {
    if (!row.can_edit || save.busy || draft === undefined || save.entry.operation !== undefined)
      return
    const input = draft.trim()
    const value = input === '' ? null : Number(input)
    if (value !== null && (!/^\d+$/.test(input) || value > assessment.max_score)) {
      setValidation(`Введите целое число от 0 до ${assessment.max_score}.`)
      return
    }
    if (value === row.score) {
      save.discardDraft()
      return
    }
    void save.save({ method: 'PUT', body: { score: value }, expected: { score: value } })
  }
  if (display === 'table-row')
    return (
      <tr>
        <td className="journal-table-student" data-label="Студент">
          {row.full_name}
          {(row.history_only || !row.is_current_group_member) && (
            <small>{row.history_only ? 'Оценка удалена' : 'Исторический результат'}</small>
          )}
        </td>
        <td data-label="Работа">
          <strong>{assessment.title}</strong>
          <small className="journal-table-secondary">{assessment.type}</small>
        </td>
        <td data-label="Дата">{assessment.planned_date ?? '—'}</td>
        <td data-label="Баллы">
          <div className="journal-score-cell">
            <input
              inputMode="numeric"
              value={draft ?? String(row.score ?? '')}
              aria-label={`Балл · ${row.full_name}`}
              aria-invalid={Boolean(validation)}
              disabled={!row.can_edit}
              readOnly={save.busy}
              onChange={(event) => {
                save.change('score', event.target.value)
                setValidation('')
              }}
              onBlur={submit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <span>/ {assessment.max_score}</span>
          </div>
          {validation && <span role="alert">{validation}</span>}
          <SaveLabel state={save.state} onRetry={save.state?.retry} />
          <button type="button" className="journal-inline-action" onClick={onHistory}>
            История
          </button>
        </td>
      </tr>
    )
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
            save.change('score', event.target.value)
            setValidation('')
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
  display = 'card',
}: {
  row: Schema['StaffAttendanceRow']
  lessonId: string
  access: JournalAccess
  readPath: string
  display?: 'card' | 'table-row'
}) {
  const path = `/api/v1/attendance/lessons/${lessonId}/students/${row.student_id}`
  const save = useRowSave(access, readPath, row.student_id, path)
  if (display === 'table-row')
    return (
      <tr>
        <td className="journal-table-student" data-label="Студент">
          {row.full_name}
          {row.is_historical && <small>Историческая отметка</small>}
        </td>
        <td data-label="Посещаемость">
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
                title={
                  !row.can_edit
                    ? 'Изменение недоступно по правилам журнала или правам доступа'
                    : title
                }
                disabled={!row.can_edit || save.busy}
                onClick={() => {
                  if (row.status === value) return
                  void save.save({
                    method: value === 'unmarked' ? 'DELETE' : 'PUT',
                    body: value === 'unmarked' ? undefined : { status: value },
                    expected: { status: value },
                  })
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {!row.can_edit && (
            <small className="journal-edit-limitation">
              Отметка недоступна по правилам занятия или правам доступа.
            </small>
          )}
        </td>
        <td data-label="Последнее изменение">
          {row.updated_at ?? '—'}
          <SaveLabel state={save.state} onRetry={save.state?.retry} />
        </td>
      </tr>
    )
  return (
    <article className="journal-student">
      <div className="journal-student__identity">
        <strong>{row.full_name}</strong>
        {row.is_historical && <small>Историческая отметка</small>}
      </div>
      {!row.can_edit && (
        <small className="journal-edit-limitation">
          Отметка недоступна по правилам занятия или правам доступа.
        </small>
      )}
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
              void save.save({
                method: value === 'unmarked' ? 'DELETE' : 'PUT',
                body: value === 'unmarked' ? undefined : { status: value },
                expected: { status: value },
              })
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
  display = 'card',
}: {
  row: Final
  fullName: string
  attestation: Attestation
  access: JournalAccess
  readPath: string
  onHistory: () => void
  display?: 'card' | 'table-row'
}) {
  const [retakeOpen, setRetakeOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const isPass = attestation === 'pass_fail'
  const path = `/api/v1/final-results/courses/${row.course_offering_id}/students/${row.student_id}`
  const save = useRowSave(access, readPath, row.student_id, path)
  const { grade, date, location } = save.entry.draft ?? {}
  const baseline = finalBaseline(row)
  const conflict =
    !save.busy && save.entry.baseline !== undefined && save.entry.baseline !== baseline
  const gradeValue = grade ?? String((isPass ? row.passed : row.grade_value) ?? '')
  const initial = {
    grade: String((isPass ? row.passed : row.grade_value) ?? ''),
    date: row.retake_date ?? '',
    location: row.retake_location ?? '',
  }
  useEffect(() => {
    const element = dialog.current
    if (retakeOpen && row.has_debt && element && !element.open) element.showModal()
    else if ((!retakeOpen || !row.has_debt) && element?.open) element.close()
  }, [retakeOpen, row.has_debt])
  function submit(remove = false) {
    if (save.busy || conflict) return
    const patch = {
      grade_value: isPass || gradeValue === '' ? null : Number(gradeValue),
      passed: isPass && gradeValue !== '' ? gradeValue === 'true' : null,
      retake_date: (date ?? row.retake_date) || null,
      retake_location: (location ?? row.retake_location)?.trim() || null,
    }
    const clearsRetake = remove || patch.passed || (patch.grade_value ?? 0) >= 3
    void save.save(
      remove
        ? { method: 'DELETE', expected: { result_id: null } }
        : {
            method: 'PATCH',
            body: patch,
            expected: {
              ...patch,
              retake_date: clearsRetake ? null : patch.retake_date,
              retake_location: clearsRetake ? null : patch.retake_location,
            },
          },
    )
  }
  function saveRetake(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!row.has_debt || save.busy || conflict) return
    const patch = {
      retake_date: (date ?? row.retake_date) || null,
      retake_location: (location ?? row.retake_location)?.trim() || null,
    }
    void save.save({
      method: 'PATCH',
      body: patch,
      expected: patch,
    })
  }
  function closeRetake() {
    if (save.busy) return
    save.discardRetakeDraft(initial.grade)
    setRetakeOpen(false)
  }
  const resultControl = (
    <select
      aria-label={`Результат: ${fullName}`}
      value={gradeValue}
      onChange={(event) => save.change('grade', event.target.value, baseline, initial)}
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
  )
  const retakeButton = (
    <button
      type="button"
      className="journal-retake-open"
      disabled={!row.has_debt}
      aria-label={`${row.retake_date || row.retake_location ? 'Изменить' : 'Назначить'} пересдачу: ${fullName}`}
      title={!row.has_debt ? 'Доступно только при наличии долга' : undefined}
      onClick={() => setRetakeOpen(true)}
    >
      {row.retake_date || row.retake_location ? 'Изменить пересдачу' : 'Назначить пересдачу'}
    </button>
  )
  const actions = (
    <div className="journal-final-actions">
      <button type="button" disabled={save.busy || conflict} onClick={() => submit()}>
        Сохранить итог
      </button>
      <button
        type="button"
        disabled={save.busy || conflict || !row.result_id}
        onClick={() => submit(true)}
      >
        Удалить итог
      </button>
      <button type="button" className="journal-inline-action" onClick={onHistory}>
        История изменений
      </button>
    </div>
  )
  return (
    <>
      {display === 'table-row' ? (
        <tr>
          <td className="journal-table-student" data-label="Студент">
            {fullName}
          </td>
          <td data-label="Результат">{resultControl}</td>
          <td data-label="Дата пересдачи">{row.retake_date ?? '—'}</td>
          <td data-label="Место пересдачи">
            {row.retake_location ?? '—'}
            {retakeButton}
          </td>
          <td data-label="Действия">
            {actions}
            <SaveLabel state={save.state} onRetry={conflict ? undefined : save.state?.retry} />
            {conflict && <p role="status">Итог изменился на сервере. Проверьте новую запись.</p>}
          </td>
        </tr>
      ) : (
        <article className="journal-student journal-student--final">
          <div className="journal-student__identity">
            <strong>{fullName}</strong>
            {actions}
          </div>
          <label className="journal-score">Итог{resultControl}</label>
          <div className="journal-retake-summary">
            Пересдача · {row.retake_date ?? 'не назначена'} ·{' '}
            {row.retake_location ?? 'место не указано'}
          </div>
          {retakeButton}
          <SaveLabel state={save.state} onRetry={conflict ? undefined : save.state?.retry} />
          {conflict && (
            <div role="status">Итог изменился на сервере. Проверьте актуальную запись.</div>
          )}
        </article>
      )}
      <dialog
        ref={dialog}
        className="teacher-journal-dialog"
        aria-labelledby={`staff-retake-title-${row.student_id}`}
        onCancel={(event) => {
          event.preventDefault()
          closeRetake()
        }}
        onClose={() => setRetakeOpen(false)}
      >
        <form onSubmit={saveRetake}>
          <h2 id={`staff-retake-title-${row.student_id}`}>Пересдача · {fullName}</h2>
          <label>
            Дата пересдачи
            <input
              type="date"
              value={date ?? row.retake_date ?? ''}
              onChange={(event) => save.change('date', event.target.value, baseline, initial)}
            />
          </label>
          <label>
            Место пересдачи
            <input
              value={location ?? row.retake_location ?? ''}
              maxLength={200}
              onChange={(event) => save.change('location', event.target.value, baseline, initial)}
            />
          </label>
          <SaveLabel state={save.state} onRetry={save.state?.retry} />
          <div className="teacher-journal-dialog__actions">
            <button type="submit" disabled={save.busy || conflict}>
              Сохранить
            </button>
            <button type="button" disabled={save.busy} onClick={closeRetake}>
              Отмена
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
