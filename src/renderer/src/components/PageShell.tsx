import { type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

export function PageShell({
  title,
  subtitle,
  onBack,
  actions,
  children
}: {
  title: string
  subtitle?: string
  onBack: () => void
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="titlebar reserve-controls-left reserve-controls-right flex h-12 shrink-0 items-center gap-3 px-4">
        <button
          onClick={onBack}
          title="Back"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{title}</span>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {subtitle && <p className="mb-6 text-sm text-text-muted">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  )
}
