import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { StudentAnnouncementFeed } from '../src/features/announcements/AnnouncementFeed'
import { StudentAccess } from '../src/features/profile/StudentProfile'
import { configureApiAuth } from '../src/shared/api/client'

const token = sessionStorage.getItem('announcement-fixture-bearer')
sessionStorage.removeItem('announcement-fixture-bearer')
const container = document.getElementById('root')
const courseId = new URLSearchParams(location.search).get('course')
if (!token || !container || !courseId) throw new Error('Announcement test fixture is incomplete')

const auth = new AbortController()
configureApiAuth(() => ({
  token,
  signal: auth.signal,
  assertCurrent: () => auth.signal.throwIfAborted(),
  refresh: () => Promise.reject(new Error('The test bearer has expired')),
  invalidate: () => auth.abort(),
}))

const client = new QueryClient()
createRoot(container).render(
  <QueryClientProvider client={client}>
    <BrowserRouter>
      <Routes>
        <Route element={<StudentAccess />}>
          <Route
            path="/e2e/announcement-feed.html"
            element={
              <>
                <button
                  type="button"
                  onClick={() =>
                    void client.invalidateQueries({ queryKey: ['course-announcements'] })
                  }
                >
                  Обновить ленту
                </button>
                <StudentAnnouncementFeed courseId={courseId} />
              </>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
)
