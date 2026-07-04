import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { ModelPicker } from './ModelPicker'
import { ContextMeter, ContextPicker, ThinkingPicker, AgentPicker } from './InferenceControls'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'

export function Composer({
  onSend,
  sending,
  onStop
}: {
  onSend: (text: string, images?: ComposerImage[]) => void
  sending?: boolean
  onStop?: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid])
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  const submit = (): void => {
    const text = value.trim()
    if (!text && images.length === 0) return
    onSend(text, images.length ? images : undefined)
    setValue('')
    setImages([])
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFilesFrom(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = imageFilesFrom(event.dataTransfer)
    setDragging(false)
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const autoGrow = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }

  const showStop = !!sending && !value.trim() && images.length === 0
  const canSend = !!value.trim() || images.length > 0

  return (
    <div className="bg-bg px-4 py-3">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={onDrop}
        className={`mx-auto max-w-3xl rounded-2xl border bg-surface-2 transition ${
          dragging
            ? 'border-accent ring-1 ring-accent/40'
            : 'border-border focus-within:border-border-strong'
        }`}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border bg-surface"
              >
                <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  title="Remove image"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={sending ? 'Queue a follow-up…' : 'Ask Roxy anything… (paste or drop images)'}
          onChange={(e) => {
            setValue(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-44 w-full resize-none bg-transparent px-4 pt-3 text-sm text-text outline-none placeholder:text-text-subtle"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Attach images"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-muted transition hover:border-border-strong hover:text-text"
            >
              <Plus className="h-4 w-4" />
            </button>
            <ModelPicker />
            <AgentPicker />
            <ThinkingPicker />
            <ContextPicker />
            <ContextMeter />
          </div>
          {showStop ? (
            <button
              onClick={onStop}
              title="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-black transition hover:bg-white/90"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title={sending ? 'Add to queue' : 'Send'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-black transition hover:bg-white/90 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )
}
