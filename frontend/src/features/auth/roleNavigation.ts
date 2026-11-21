import type { components } from '../../shared/api/schema'
import type { NavigationItem } from '../../app/CabinetLayout'

export type AuthorizationContext = components['schemas']['AuthorizationContext']
export type PermissionCode = components['schemas']['PermissionCode']

// Presentation metadata only: the server supplies effective grants and enforces access.
export const staffSections: {
  permission: PermissionCode
  label: string
  icon: NavigationItem['icon']
  disabled?: boolean
  visible?: boolean
}[] = [
  { permission: 'applications.review', label: 'Заявления', icon: 'clipboard' },
  { permission: 'schedule.edit', label: 'Редактор расписания', icon: 'calendar' },
  { permission: 'grades.edit', label: 'Баллы', icon: 'chart', visible: false },
  { permission: 'attendance.edit', label: 'Посещаемость', icon: 'checklist', visible: false },
  { permission: 'students.read', label: 'Поиск студентов', icon: 'users' },
  { permission: 'students.edit', label: 'Академические сведения', icon: 'book', visible: false },
  {
    permission: 'students.status.edit',
    label: 'Академические статусы',
    icon: 'chart',
  },
  { permission: 'groups.manage', label: 'Учебные группы', icon: 'groups', disabled: true },
  { permission: 'news.publish', label: 'Публикация новостей', icon: 'news' },
]

export function getStaffJournalRoute(permission: 'grades.edit' | 'attendance.edit') {
  return permission === 'grades.edit'
    ? '/staff/journals?tab=work'
    : '/staff/journals?tab=attendance'
}

export function hasPermission(context: AuthorizationContext, code: PermissionCode) {
  return (
    context.permissions.some((grant) => grant.permission_code === code) ||
    (code === 'students.read' &&
      context.permissions.some((grant) => grant.permission_code === 'students.status.edit'))
  )
}

export function getRoleNavigation(context: AuthorizationContext): NavigationItem[] {
  if (context.role === 'teacher')
    return [
      { to: '/teacher/journals', label: 'Мои журналы', icon: 'graduation' },
      { to: '/teacher/schedule', label: 'Расписание', icon: 'calendar' },
    ]
  if (context.role === 'admin') return [{ to: '/admin/users', label: 'Пользователи', icon: 'user' }]
  if (context.role !== 'staff') return []
  return staffSections
    .filter(
      ({ permission, disabled, visible }) =>
        disabled || (visible !== false && hasPermission(context, permission)),
    )
    .map(({ permission, label, icon, disabled }) => ({
      to:
        permission === 'applications.review'
          ? '/staff/applications'
          : permission === 'students.read'
            ? '/staff/students'
            : permission === 'students.status.edit'
              ? '/staff/students/status'
              : permission === 'news.publish'
                ? '/staff/news/new'
                : permission === 'schedule.edit'
                  ? '/staff/schedule'
                  : '/staff',
      label,
      icon,
      disabled,
    }))
    .concat(
      hasPermission(context, 'grades.edit') || hasPermission(context, 'attendance.edit')
        ? [
            {
              to: '/staff/journals',
              label: 'Журнал деканата',
              icon: 'graduation' as const,
              disabled: false,
            },
          ]
        : [],
    )
}

export function getStartRoute(context: AuthorizationContext) {
  if (context.role === 'student') return '/schedule'
  if (context.role === 'teacher') return '/teacher/journals'
  if (context.role === 'admin') return '/admin/users'
  if (hasPermission(context, 'applications.review')) return '/staff/applications'
  if (hasPermission(context, 'students.read')) return '/staff/students'
  return '/staff'
}
