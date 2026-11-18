const marks = {
  attended: ['✓', 'Был'],
  absent: ['Н', 'Не был'],
  unmarked: ['—', 'Не отмечено'],
} as const

export function AttendanceMark({
  status,
  historical,
}: {
  status: keyof typeof marks
  historical?: boolean
}) {
  const [symbol, text] = marks[status]
  return (
    <span className="attendance-mark" data-status={status}>
      <span aria-hidden="true">{symbol}</span> {text}
      {historical && ' · историческая отметка'}
    </span>
  )
}
