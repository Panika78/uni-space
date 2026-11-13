const paths = {
  calendar: 'M4 6h16v15H4zM8 3v6M16 3v6M4 11h16',
  book: 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1m0-14v14',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  news: 'M4 4h16v17H4zM8 8h8M8 12h8M8 16h5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
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
