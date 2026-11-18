import { ApiClientError, apiFetch } from '../../shared/api/client'

export type StudentReadScope = {
  key: readonly ['student', string, string, string]
  header: string | null
}

export async function getStudentRead<T>(
  path: string,
  signal: AbortSignal,
  scope: StudentReadScope | null,
  termId?: string,
) {
  let serverScope: string | null = null
  let serverTerm: string | null = null
  const data = await apiFetch<T>(path, {
    authenticated: true,
    signal,
    onResponseHeaders(headers) {
      serverScope = headers.get('X-Student-Scope')
      serverTerm = headers.get('X-Academic-Term-Id')
    },
  })
  if ((scope?.header && serverScope !== scope.header) || (termId && termId !== serverTerm)) {
    throw new ApiClientError('Учебные данные изменились', 'student_scope_changed')
  }
  return data
}

type Profile = import('../../shared/api/schema').components['schemas']['StudentProfile']

export async function getStudentProfile({
  signal,
}: {
  signal: AbortSignal
}): Promise<Profile & { studentReadScope?: string }> {
  let scope: string | null = null
  const profile = await apiFetch<Profile>('/api/v1/users/me', {
    authenticated: true,
    signal,
    onResponseHeaders: (headers) => {
      scope = headers.get('X-Student-Scope')
    },
  })
  return { ...profile, ...(scope ? { studentReadScope: String(scope) } : {}) }
}
