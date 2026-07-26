/**
 * A composable Queue UI — a collapsible section with a scrollable list of
 * pending items, each with a status indicator, content, optional image/file
 * attachments, and hover-revealed actions. A native, theme-matched adaptation
 * of the AI Elements Queue API (AI Elements targets Tailwind v3 / shadcn, which
 * this app doesn't use).
 */
import {
  createContext,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode
} from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'

// ---- Collapsible section context --------------------------------------------

interface SectionState {
  open: boolean
  setOpen: (value: boolean) => void
}
const QueueSectionContext = createContext<SectionState | null>(null)

function useQueueSection(): SectionState {
  const ctx = useContext(QueueSectionContext)
  if (!ctx) throw new Error('Queue section parts must be used inside <QueueSection>')
  return ctx
}

// ---- Root --------------------------------------------------------------------

export function Queue({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn('rounded-xl border border-border bg-surface/60 p-1.5', className)} {...props} />
  )
}

// ---- Section (collapsible) ---------------------------------------------------

export function QueueSection({
  defaultOpen = true,
  className,
  children,
  ...props
}: { defaultOpen?: boolean } & HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <QueueSectionContext.Provider value={{ open, setOpen }}>
      <div className={cn('flex flex-col', className)} {...props}>
        {children}
      </div>
    </QueueSectionContext.Provider>
  )
}

export function QueueSectionTrigger({
  className,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const { open, setOpen } = useQueueSection()
  return (
    <button
      type="button"
      onClick={(e) => {
        setOpen(!open)
        onClick?.(e)
      }}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/5',
        className
      )}
      {...props}
    >
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform duration-200 ease-out-quart',
          open && 'rotate-90'
        )}
      />
      {children}
    </button>
  )
}

export function QueueSectionLabel({
  label,
  count,
  icon,
  className,
  ...props
}: {
  label?: string
  count?: number
  icon?: ReactNode
} & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={cn('flex items-center gap-1.5 text-xs font-medium text-text-muted', className)}
      {...props}
    >
      {icon}
      {typeof count === 'number' && (
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums text-text-subtle">
          {count}
        </span>
      )}
      {label}
    </span>
  )
}

export function QueueSectionContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element | null {
  const { open } = useQueueSection()
  if (!open) return null
  return (
    <div className={cn('px-1 pb-1 pt-1', className)} {...props}>
      {children}
    </div>
  )
}

// ---- List + items ------------------------------------------------------------

export function QueueList({ className, ...props }: HTMLAttributes<HTMLUListElement>): JSX.Element {
  return (
    <ul className={cn('flex max-h-52 flex-col gap-1 overflow-y-auto', className)} {...props} />
  )
}

export function QueueItem({ className, ...props }: LiHTMLAttributes<HTMLLIElement>): JSX.Element {
  return (
    <li
      className={cn(
        'group flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 transition-colors hover:border-border-strong',
        className
      )}
      {...props}
    />
  )
}

export function QueueItemIndicator({
  completed = false,
  className,
  ...props
}: { completed?: boolean } & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={cn(
        'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
        completed ? 'bg-success' : 'bg-text-subtle',
        className
      )}
      {...props}
    />
  )
}

export function QueueItemContent({
  completed = false,
  className,
  ...props
}: { completed?: boolean } & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={cn(
        'block whitespace-pre-wrap break-words text-xs leading-relaxed text-text',
        completed && 'text-text-subtle line-through opacity-60',
        className
      )}
      {...props}
    />
  )
}

export function QueueItemDescription({
  completed = false,
  className,
  ...props
}: { completed?: boolean } & HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('mt-0.5 text-[11px] text-text-subtle', completed && 'opacity-60', className)}
      {...props}
    />
  )
}

export function QueueItemActions({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
        className
      )}
      {...props}
    />
  )
}

export function QueueItemAction({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'press-scale flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-white/5 hover:text-text',
        className
      )}
      {...props}
    />
  )
}

// ---- Attachments -------------------------------------------------------------

export function QueueItemAttachment({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('mt-1.5 flex flex-wrap gap-1.5', className)} {...props} />
}

export function QueueItemImage({
  className,
  alt = '',
  ...props
}: ImgHTMLAttributes<HTMLImageElement>): JSX.Element {
  return (
    <img
      alt={alt}
      className={cn('h-9 w-9 rounded-md border border-border object-cover', className)}
      {...props}
    />
  )
}

export function QueueItemFile({ className, ...props }: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-muted',
        className
      )}
      {...props}
    />
  )
}
