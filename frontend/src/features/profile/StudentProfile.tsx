import universityBuilding from '../../assets/university-building.webp'
import './profile.css'
import { useQuery } from '@tanstack/react-query'
import { Outlet } from 'react-router-dom'
import { UserMenu } from '../../app/StudentLayout'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { Icon } from '../../shared/ui/Icon'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'

import { ProfileContext, useStudentProfile, getStudentInitials } from './profileContext'
import type { Profile } from './profileContext'
export { useStudentProfile, getStudentInitials } from './profileContext'

export function StudentAccess() {
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
        <UserMenu logoutOnly />
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
  const profile = useStudentProfile()
  if (!profile) return null
  const initials = getStudentInitials(profile.full_name)
  return (
    <article className="section-page profile-page">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1>Мой профиль</h1>
      <p className="profile-subtitle">Личная информация и сведения об обучении</p>
      <header className="profile-heading">
        <img className="profile-building" src={universityBuilding} alt="" aria-hidden="true" />
        <span className="profile-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="profile-heading__copy">
          <h2>{profile.full_name}</h2>
          <p className="profile-meta">
            {profile.group.name}
            <span className="profile-status" data-status={profile.academic_status}>
              {statuses[profile.academic_status]}
            </span>
          </p>
        </div>
      </header>
      <div className="profile-grid">
        <section className="profile-personal">
          <h2>
            <Icon name="user" />
            Личные данные
          </h2>
          <dl>
            <dt>ФИО</dt>
            <dd>{profile.full_name}</dd>
            <dt>Логин</dt>
            <dd>{profile.login}</dd>
          </dl>
        </section>
        <section className="profile-education">
          <h2>
            <Icon name="graduation" />
            Обучение
          </h2>
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
        <section className="profile-contacts">
          <h2>
            <Icon name="info" />
            Контакты
          </h2>
          <p>Контактные данные не предоставлены.</p>
        </section>
      </div>
    </article>
  )
}
