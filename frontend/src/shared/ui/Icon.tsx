const paths = {
  calendar: 'M4 6h16v15H4zM8 3v6M16 3v6M4 11h16',
  book: 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1m0-14v14',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  news: 'M4 4h16v17H4zM8 8h8M8 12h8M8 16h5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12l5 5L20 7',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  user: 'M19 21v-2a7 7 0 0 0-14 0v2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  graduation: 'M2 9l10-5 10 5-10 5-10-5zm4 3v6c4 3 8 3 12 0v-6M22 10v7',
  info: 'M12 17v-5M12 8h.01M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
} as const

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
