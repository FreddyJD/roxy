import { memo } from 'react'
import { User } from 'lucide-react'
import roxy from '../assets/roxy.png'
import type { MessagePart, MessageRole } from '@shared/types'
import { MessageParts } from './MessageParts'
import { HOVERABLE_THUMB, ImagePreview } from './ImagePreview'
import { cn } from '../lib/cn'

/** Flatten a turn's text parts down to plain text (for user messages). */
function partsToText(parts: MessagePart[]): string {
  return parts.map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : '')).join('')
}

function MessageBubbleImpl({
  role,
  parts,
  streaming = false
}: {
  role: MessageRole
  parts: MessagePart[]
  streaming?: boolean
}): JSX.Element {
  const isUser = role === 'user'
  const imageParts = parts.filter(
    (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image'
  )
  const text = partsToText(parts)
  return (
    <div className="flex gap-3 px-1 py-3">
      <div className="mt-0.5 shrink-0">
        {isUser ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-muted">
            <User className="h-4 w-4" />
          </div>
        ) : (
          <img
            src={roxy}
            alt="Roxy"
            className="h-7 w-7 rounded-lg object-cover ring-1 ring-border"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-medium text-text-muted">{isUser ? 'You' : 'Roxy'}</div>
        {isUser ? (
          <div className="flex flex-col gap-2">
            {imageParts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imageParts.map((img, i) => (
                  // These are object-cover, so a tall screenshot is shown cropped
                  // — hover floats the whole, uncropped image.
                  <ImagePreview key={i} src={img.dataUrl} name={img.name}>
                    <img
                      src={img.dataUrl}
                      alt={img.name ?? 'pasted image'}
                      className={cn(HOVERABLE_THUMB, 'max-h-48 max-w-[12rem] rounded-lg')}
                    />
                  </ImagePreview>
                ))}
              </div>
            )}
            {text && (
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
                {text}
              </div>
            )}
          </div>
        ) : (
          <MessageParts parts={parts} streaming={streaming} />
        )}
      </div>
    </div>
  )
}

/**
 * Memoized because the transcript re-renders on every streamed token.
 *
 * `streaming` writes a brand-new parts array into the store on each delta, which
 * re-renders ChatView, which previously re-rendered all 30 settled bubbles with
 * it — re-parsing every markdown block through Streamdown ~80 times a second for
 * messages whose content had not changed since they were written to SQLite.
 *
 * A settled message's `parts` array is a stable reference (it comes straight off
 * the loaded row and is never rebuilt), so the default shallow compare is both
 * correct and enough: only the live bubble, whose array genuinely changes,
 * re-renders.
 */
export const MessageBubble = memo(MessageBubbleImpl)
