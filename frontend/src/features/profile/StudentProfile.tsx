import { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'

type Profile = components['schemas']['StudentProfile']
const ProfileContext = createContext<Profile | null>(null)

export function StudentAccess() {
  const { logout } = useAuth()
  const query = useQuery({
    queryKey: ['student-profile'],
    queryFn: ({ signal }) => apiFetch<Profile>('/api/v1/users/me', { authenticated: true, signal }),
    retry: false,
    staleTime: 0,
  })
  if (query.isPending) return <LoadingState title="Загружаем профиль…" />
  if (query.isError) {
    const forbidden = query.error instanceof ApiClientError && query.error.status === 403
    return (
      <ErrorState
        title={forbidden ? 'Доступ запрещён' : 'Не удалось загрузить профиль'}
        description={
          forbidden
            ? 'Студенческий кабинет доступен только студентам.'
            : 'Проверьте соединение и повторите попытку.'
        }
        onRetry={
          forbidden
            ? undefined
            : () => {
                void query.refetch()
              }
        }
      >
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Выйти из аккаунта?')) void logout()
          }}
        >
          Выйти
        </button>
      </ErrorState>
    )
  }
  return (
    <ProfileContext.Provider value={query.data}>
      <Outlet />
    </ProfileContext.Provider>
  )
}

const statuses = {
  enrolled: 'Обучается',
  academic_leave: 'Академический отпуск',
  expelled: 'Отчислен',
  graduated: 'Выпускник',
}
export function StudentProfilePage() {
  const profile = useContext(ProfileContext)
  if (!profile) return null
  const initials = profile.full_name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
  return (
    <article className="section-page profile-page">
      <h1>Мой профиль</h1>
      <header className="profile-heading">
        <span className="profile-avatar" aria-hidden="true">
          {initials}
        </span>
        <div>
          <h2>{profile.full_name}</h2>
          <p>{profile.group.name}</p>
        </div>
      </header>
      <section>
        <h2>Личные данные</h2>
        <dl>
          <dt>ФИО</dt>
          <dd>{profile.full_name}</dd>
          <dt>Логин</dt>
          <dd>{profile.login}</dd>
        </dl>
      </section>
      <section>
        <h2>Обучение</h2>
        <dl>
          <dt>Факультет</dt>
          <dd>{profile.faculty.name}</dd>
          <dt>Программа</dt>
          <dd>
            {profile.program.code} · {profile.program.name}
          </dd>
          <dt>Направление</dt>
          <dd>
            {profile.direction.code} · {profile.direction.name}
          </dd>
          <dt>Курс</dt>
          <dd>{profile.course_number}</dd>
          <dt>Группа</dt>
          <dd>{profile.group.name}</dd>
          <dt>Академический статус</dt>
          <dd>{statuses[profile.academic_status]}</dd>
        </dl>
      </section>
      <section>
        <h2>Контакты</h2>
        <p>Контактные данные не предоставлены.</p>
      </section>
    </article>
  )
}
