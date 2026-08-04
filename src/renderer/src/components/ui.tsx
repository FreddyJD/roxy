import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react'
import { cn } from '../lib/cn'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

// Bordered variants carry `sq-ring`: the squircle mask would shave the square
// corners off a real border, so its hairline is repainted inside the shape.
// `--sq-ring` has to state the color because a paint worklet can't read the
// element's own `border-color`.

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-white text-black hover:bg-white/90',
  secondary: 'bg-surface-2 text-text border border-border hover:bg-elevated sq-ring',
  ghost: 'text-text-muted hover:text-text hover:bg-white/5',
  danger:
    'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 sq-ring [--sq-ring:color-mix(in_srgb,var(--color-danger)_30%,transparent)]'
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      className={cn(
        'press-scale sq sq-lg inline-flex items-center justify-center rounded-lg font-medium focus:outline-none disabled:cursor-not-allowed disabled:opacity-40',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...props}
    />
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          // `inset-ring` rather than `ring`: an outer ring is a box-shadow, and
          // the squircle mask paints only what's inside the shape, so an outer
          // glow would be erased. An inset ring sits in the border box and the
          // mask simply rounds it. `--sq-ring` is a registered property, so it
          // animates like the `border-color` it stands in for.
          'sq sq-lg sq-ring h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none transition-[border-color,box-shadow,--sq-ring] placeholder:text-text-subtle focus:border-accent/70 focus:inset-ring-2 focus:inset-ring-accent/20 focus:[--sq-ring:color-mix(in_srgb,var(--color-accent)_70%,transparent)]',
          className
        )}
        {...props}
      />
    )
  }
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'sq sq-lg sq-ring w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none transition-[border-color,box-shadow,--sq-ring] placeholder:text-text-subtle focus:border-accent/70 focus:inset-ring-2 focus:inset-ring-accent/20 focus:[--sq-ring:color-mix(in_srgb,var(--color-accent)_70%,transparent)]',
        className
      )}
      {...props}
    />
  )
})

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  // `sq-frame`, not `sq`: a card is a container, and the mask `sq` applies clips
  // descendants the way `overflow-hidden` does. Painting the fill as this
  // element's own background instead leaves children (and any shadow) alone.
  return (
    <div
      className={cn(
        'sq-frame sq-ring sq-xl sq-fill-surface rounded-xl border border-border bg-surface',
        className
      )}
      {...props}
    />
  )
}

export function Badge({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        // Pills stay circular: at `rounded-full` the corner is a semicircle with
        // no straight edge to blend into, so there is no curvature break to fix.
        'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-text-muted',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange?: (value: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        // Flex + padding centers the knob, rather than absolute offsets. The
        // knob had no `left`, so `absolute` anchored it to its static position
        // -- the middle of the button, via the UA's text-align: center -- and
        // translate-x-4 then pushed it clean off the track. The 1px border also
        // existed only while unchecked, so the track resized on every toggle;
        // an inset ring paints the same hairline without affecting layout.
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40',
        checked ? 'bg-accent' : 'bg-surface-2 inset-ring-1 inset-ring-border',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <span
        className={cn(
          'h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-drawer',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  )
}
