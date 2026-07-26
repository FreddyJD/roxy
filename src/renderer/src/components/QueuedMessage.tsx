import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronUp, ImagePlus, Pencil, X } from 'lucide-react'
import type { QueueItem as QueueItemType } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'
import {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemImage,
  QueueItemIndicator
} from './Queue'

/** Give a persisted QueueImage the extra fields the composer editor needs (id + name). */
function toComposerImages(item: QueueItemType): ComposerImage[] {
  return (item.images ?? []).map((img) => ({
    id: crypto.randomUUID(),
    dataUrl: img.dataUrl,
    mediaType: img.mediaType,
    name: img.name ?? 'image'
  }))
}

/**
 * One row of the pending queue. Read-only by default (content + image
 * thumbnails + reorder/remove/edit actions); the pencil flips it into an inline
 * editor that preserves the item's queue position and lets you rewrite the text
 * and add/remove attached images before saving.
 */
export function QueuedMessage({
  item,
  index,
  total
}: {
  item: QueueItemType
  index: number
  total: number
}): JSX.Element {
  const editQueued = useRoxyStore((s) => s.editQueued)
  const removeQueued = useRoxyStore((s) => s.removeQueued)
  const moveQueued = useRoxyStore((s) => s.moveQueued)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const startEditing = (): void => {
    setDraft(item.content)
    setDraftImages(toComposerImages(item))
    setEditing(true)
    // Focus + size the textarea once it mounts.
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const cancelEditing = (): void => {
    setEditing(false)
    setDraft('')
    setDraftImages([])
    setDragging(false)
  }

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setDraftImages((prev) => [...prev, ...valid])
  }

  const save = async (): Promise<void> => {
    const text = draft.trim()
    // An empty edit would silently drop the item — treat clearing everything as
    // a removal instead (matches the × affordance), so nothing invisible remains.
    if (!text && draftImages.length === 0) {
      await removeQueued(item.id)
      cancelEditing()
      return
    }
    setSaving(true)
    try {
      await editQueued(item.id, text, draftImages.length ? draftImages : undefined)
      cancelEditing()
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFilesFrom(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const files = imageFilesFrom(e.dataTransfer)
    setDragging(false)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const autoGrow = (): void => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // ---- Edit mode -------------------------------------------------------------
  if (editing) {
    return (
      <QueueItem className="flex-col items-stretch gap-0 !border-border-strong bg-surface p-0">
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
          className={`rounded-lg transition ${dragging ? 'ring-1 ring-accent/40' : ''}`}
        >
          {draftImages.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
              {draftImages.map((img) => (
                <div
                  key={img.id}
                  className="group/img relative h-12 w-12 overflow-hidden rounded-md border border-border bg-surface-2"
                >
                  <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setDraftImages((prev) => prev.filter((i) => i.id !== img.id))}
                    title="Remove image"
                    className="press-scale absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover/img:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textRef}
            value={draft}
            rows={1}
            placeholder="Edit queued message…"
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-52 w-full resize-none bg-transparent px-2.5 pb-1.5 pt-2.5 text-xs leading-relaxed text-text outline-none placeholder:text-text-subtle"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Attach images"
              className="press-scale flex h-6 items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text"
            >
              <ImagePlus className="h-3.5 w-3.5" /> Image
            </button>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={cancelEditing}
                className="press-scale flex h-6 items-center rounded-md px-2 text-[11px] text-text-muted hover:bg-white/5 hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="press-scale flex h-6 items-center gap-1 rounded-md bg-white px-2 text-[11px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" /> Save
              </button>
            </div>
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
      </QueueItem>
    )
  }

  // ---- Read-only row ---------------------------------------------------------
  return (
    <QueueItem>
      <QueueItemIndicator />
      <div className="min-w-0 flex-1">
        {item.content && <QueueItemContent>{item.content}</QueueItemContent>}
        {item.images && item.images.length > 0 && (
          <QueueItemAttachment>
            {item.images.map((img, j) => (
              <QueueItemImage key={j} src={img.dataUrl} alt={img.name ?? 'image'} />
            ))}
          </QueueItemAttachment>
        )}
        {!item.content && (!item.images || item.images.length === 0) && (
          <QueueItemContent className="italic text-text-subtle">(empty)</QueueItemContent>
        )}
      </div>
      <QueueItemActions>
        <QueueItemAction onClick={startEditing} title="Edit message">
          <Pencil className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction
          onClick={() => moveQueued(item.id, 'up')}
          disabled={index === 0}
          title="Move up (run sooner)"
          className="disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-subtle"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction
          onClick={() => moveQueued(item.id, 'down')}
          disabled={index === total - 1}
          title="Move down"
          className="disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-subtle"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction onClick={() => removeQueued(item.id)} title="Remove from queue">
          <X className="h-3.5 w-3.5" />
        </QueueItemAction>
      </QueueItemActions>
    </QueueItem>
  )
}
