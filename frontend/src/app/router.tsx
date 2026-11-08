import { createBrowserRouter, Link, NavLink, Outlet } from 'react-router-dom'

function AppLayout() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" to="/" aria-label="Uni Space — главная">Uni Space</Link>
        <nav aria-label="Основная навигация">
          <NavLink to="/" end>Главная</NavLink>
          <NavLink to="/about">О проекте</NavLink>
        </nav>
      </header>
      <main id="main-content"><Outlet /></main>
    </div>
  )
}

function HomePage() {
  return (
    <section className="welcome-card" aria-labelledby="home-title">
      <p className="eyebrow">Студенческий кабинет</p>
      <h1 id="home-title">Добро пожаловать в Uni Space</h1>
      <p>Ваше университетское пространство начинается здесь.</p>
      <NavLink className="text-link" to="/about">Узнать о проекте <span aria-hidden="true">→</span></NavLink>
    </section>
  )
}

function AboutPage() {
  return (
    <section className="welcome-card" aria-labelledby="about-title">
      <p className="eyebrow">О проекте</p>
      <h1 id="about-title">Всё важное об учёбе — в одном месте</h1>
      <p>Uni Space объединит расписание, успеваемость и университетские услуги.</p>
      <NavLink className="text-link" to="/">Вернуться на главную <span aria-hidden="true">→</span></NavLink>
    </section>
  )
}

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/about', element: <AboutPage /> },
    ],
  },
])
