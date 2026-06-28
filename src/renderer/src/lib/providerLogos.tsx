/** Company brand logos for providers, copied into assets/providers/ via
 *  `npm run icons:providers`. Falls back to a lettered badge when missing. */
const modules = import.meta.glob('../assets/providers/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const LOGOS: Record<string, string> = {}
for (const [path, url] of Object.entries(modules)) {
  const id = path.split('/').pop()?.replace('.svg', '')
  if (id) LOGOS[id] = url
}

export function hasProviderLogo(id: string): boolean {
  return id in LOGOS
}

export function ProviderLogo({
  id,
  name,
  size = 20
}: {
  id: string
  name: string
  size?: number
}): JSX.Element {
  const logo = LOGOS[id]
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        className="object-contain"
        style={{ width: size, height: size }}
        draggable={false}
      />
    )
  }
  return (
    <span
      className="flex items-center justify-center rounded-md bg-white/10 font-semibold text-text"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {name.charAt(0)}
    </span>
  )
}
