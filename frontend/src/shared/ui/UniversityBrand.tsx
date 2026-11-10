const universityName =
  'Российский государственный университет чародейства и волшебства имени А. М. Кашпировского'

export function BrandMark() {
  return (
    <img className="brand-mark" src="/assets/university-emblem.png" alt="" aria-hidden="true" />
  )
}

export function UniversityBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`university-brand${compact ? ' university-brand--compact' : ''}`}>
      <BrandMark />
      <span className="university-brand__copy">
        <strong>РГУЧВ</strong>
        <small>{universityName}</small>
      </span>
    </div>
  )
}
