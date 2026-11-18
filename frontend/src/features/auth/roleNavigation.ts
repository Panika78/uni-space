import type { components } from '../../shared/api/schema'
import type { NavigationItem } from '../../app/CabinetLayout'

export type AuthorizationContext = components['schemas']['AuthorizationContext']
export type PermissionCode = components['schemas']['PermissionCode']

// Presentation metadata only: the server supplies effective grants and enforces access.
export const staffSections: { permission: PermissionCode; label: string }[] = [
  { permission: 'applications.review', label: 'Заявления' },
  { permission: 'schedule.edit', label: 'Редактор расписания' },
  { permission: 'grades.edit', label: 'Баллы' },
  { permission: 'attendance.edit', label: 'Посещаемость' },
  { permission: 'students.read', label: 'Поиск студентов' },
  { permission: 'students.edit', label: 'Академические сведения' },
  { permission: 'students.status.edit', label: 'Академические статусы' },
  { permission: 'groups.manage', label: 'Учебные группы' },
  { permission: 'news.publish', label: 'Публикация новостей' },
]

export function getStaffJournalRoute(permission: 'grades.edit' | 'attendance.edit') {
  return permission === 'grades.edit'
    ? '/staff/journals?tab=work'
    : '/staff/journals?tab=attendance'
}

export function hasPermission(context: AuthorizationContext, code: PermissionCode) {
  return context.permissions.some((grant) => grant.permission_code === code)
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
    .filter(({ permission }) => hasPermission(context, permission))
    .map(({ permission, label }) => ({
      to:
        permission === 'applications.review'
          ? '/staff/applications'
          : permission === 'students.read'
            ? '/staff/students'
            : permission === 'students.status.edit'
              ? '/staff/students/status'
              : permission === 'news.publish'
                ? '/staff/news'
                : permission === 'schedule.edit'
                  ? '/staff/schedule'
                  : permission === 'grades.edit' || permission === 'attendance.edit'
                    ? getStaffJournalRoute(permission)
                    : `/staff#${permission}`,
      label,
      icon: permission === 'schedule.edit' ? 'calendar' : 'file',
    }))
}

export function getStartRoute(context: AuthorizationContext) {
  if (context.role === 'student') return '/schedule'
  if (context.role === 'teacher') return '/teacher/journals'
  if (context.role === 'admin') return '/admin/users'
  if (hasPermission(context, 'applications.review')) return '/staff/applications'
  if (hasPermission(context, 'students.read')) return '/staff/students'
  if (hasPermission(context, 'students.status.edit')) return '/staff/students/status'
  return '/staff'
}
