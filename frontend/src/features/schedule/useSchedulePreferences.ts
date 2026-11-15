import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

type Preferences = components['schemas']['PreferencesResponse']
type Snapshot = Preferences & { hasUncertainSave: boolean }
const key = ['user-preferences']
export const PREFERENCE_SAVE_DEADLINE_MS = 15_000

class PreferenceSaveTimeout extends Error {}

function isUncertainSave(error: unknown): boolean {
  return (
    error instanceof PreferenceSaveTimeout ||
    (error instanceof ApiClientError && ['network_error', 'invalid_response'].includes(error.code))
  )
}

async function updateSchedulePreference(show: boolean): Promise<Preferences> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new PreferenceSaveTimeout('Preference save deadline exceeded')
      reject(error)
      controller.abort(error)
    }, PREFERENCE_SAVE_DEADLINE_MS)
  })
  try {
    return await Promise.race([
      apiFetch<Preferences>('/api/v1/users/me/preferences', {
        authenticated: true,
        method: 'PATCH',
        signal: controller.signal,
        body: JSON.stringify({ show_cancelled_lessons: show }),
      }),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function useSchedulePreferences() {
  const queryClient = useQueryClient()
  const savePreferences = useMutation({
    mutationFn: updateSchedulePreference,
    onMutate: async () => {
      const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      return { query }
    },
    onSuccess: async (data, _show, context) => {
      if (
        !context?.query ||
        context.query !== queryClient.getQueryCache().find({ queryKey: key, exact: true })
      )
        return
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      if (context.query !== queryClient.getQueryCache().find({ queryKey: key, exact: true })) return
      queryClient.setQueryData<Snapshot>(key, (previous) => ({
        ...data,
        hasUncertainSave: previous?.hasUncertainSave ?? false,
      }))
    },
    onError: (error, _show, context) => {
      if (
        !isUncertainSave(error) ||
        !context?.query ||
        context.query !== queryClient.getQueryCache().find({ queryKey: key, exact: true })
      )
        return
      // Keep uncertainty in the personal Query cache across schedule remounts.
      // AuthSession clears this cache on account changes. A GET is a snapshot,
      // never proof that a previously dispatched write cannot still commit.
      queryClient.setQueryData<Snapshot>(
        key,
        (previous) =>
          previous && {
            ...previous,
            hasUncertainSave: true,
          },
      )
      void queryClient.invalidateQueries({ queryKey: key, exact: true })
    },
  })
  const preferences = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<Snapshot> => {
      const data = await apiFetch<Preferences>('/api/v1/users/me/preferences', {
        authenticated: true,
        signal,
      })
      return {
        ...data,
        hasUncertainSave: queryClient.getQueryData<Snapshot>(key)?.hasUncertainSave ?? false,
      }
    },
    refetchInterval: (query) =>
      query.state.data?.hasUncertainSave && !savePreferences.isPending ? 10_000 : false,
    refetchOnWindowFocus: (query) =>
      Boolean(query.state.data?.hasUncertainSave) && !savePreferences.isPending,
    refetchOnReconnect: (query) =>
      Boolean(query.state.data?.hasUncertainSave) && !savePreferences.isPending,
  })
  return {
    preferences,
    savePreferences,
    // Absence of a row is handled by the API. Unknown reads are never default true.
    showCancelled: preferences.isSuccess && preferences.data.show_cancelled_lessons === true,
    hasUncertainSave: preferences.data?.hasUncertainSave === true,
    hasExplicitSaveError: savePreferences.isError && !isUncertainSave(savePreferences.error),
  }
}
