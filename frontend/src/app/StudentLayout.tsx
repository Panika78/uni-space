import { Link } from 'react-router-dom'
import { useStudentProfile, getStudentInitials } from '../features/profile/profileContext'
import { CabinetLayout } from './CabinetLayout'
import { Icon } from '../shared/ui/Icon'
import { UnavailableState } from '../shared/ui/StatusStates'

export const studentNavigation = [
  { to: '/schedule', label: 'Расписание', icon: 'calendar' },
  { to: '/academics', label: 'Успеваемость', icon: 'graduation' },
  { to: '/services', label: 'Услуги и документы', icon: 'file' },
  { to: '/news', label: 'Новости', icon: 'book' },
] as const

export function StudentLayout() {
  const profile = useStudentProfile()
  return (
    <CabinetLayout
      navigation={studentNavigation}
      student
      home="/schedule"
      initials={getStudentInitials(profile?.full_name)}
    />
  )
}

export function UnavailableSection({ title }: { title: string }) {
  return (
    <section className="section-page unavailable-page" aria-labelledby="section-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="section-title">{title}</h1>
      <p className="service-subtitle">Раздел появится в одном из следующих этапов</p>
      <UnavailableState
        icon={<Icon name="settings" />}
        title="Функция пока недоступна"
        description="Сейчас этот раздел ещё не реализован."
      >
        <Link className="service-action service-action--light" to="/profile">
          Вернуться к профилю
        </Link>
      </UnavailableState>
    </section>
  )
}
