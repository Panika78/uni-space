import { QueryClient } from '@tanstack/react-query'

export function createQueryClient() {
  // Retry belongs exclusively to shared/api: one replay after access_expired.
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })
}
