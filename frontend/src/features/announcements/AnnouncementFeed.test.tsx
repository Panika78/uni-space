import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { apiFetch } from '../../shared/api/client'
import { ProfileContext, type Profile } from '../profile/profileContext'
import { StudentAnnouncementFeed } from './AnnouncementFeed'

vi.mock('../../shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

it('hides cached addresses after detecting transfer and switches to the new group key', async () => {
  const client = new QueryClient()
  const profile = { id: '1', group: { id: '10', name: 'A' } } as Profile
  const node = (group: Profile['group']) => (
    <QueryClientProvider client={client}>
      <ProfileContext.Provider value={{ ...profile, group }}>
        <StudentAnnouncementFeed courseId="20" />
      </ProfileContext.Provider>
    </QueryClientProvider>
  )
  let serverGroup = '10'
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    options?.onResponseHeaders?.(new Headers({ 'X-Announcement-Group-Id': serverGroup }))
    return {
      items: [
        {
          id: serverGroup,
          title: `Объявление группы ${serverGroup}`,
          body: 'Текст',
          excerpt: 'Текст',
          teacher: { id: '1', full_name: 'Преподаватель' },
          created_at: '2026-11-18T08:00:00Z',
        },
      ],
      next_cursor: null,
    }
  })
  const view = render(node(profile.group))
  await screen.findByText('Объявление группы 10')
  serverGroup = '11'
  await client.invalidateQueries({ queryKey: ['course-announcements'] })
  await screen.findByText('Не удалось загрузить объявления')
  expect(screen.queryByText('Объявление группы 10')).toBeNull()
  expect(screen.queryByText('Объявление группы 11')).toBeNull()

  view.rerender(node({ id: '11', name: 'B' }))
  await screen.findByText('Объявление группы 11')
  expect(screen.queryByText('Объявление группы 10')).toBeNull()
  await waitFor(() => {
    expect(
      client.getQueryData(['course-announcements', '1', 'student', '20', '10']),
    ).toBeUndefined()
  })
})
