import { User } from 'lucide-react'
import roxy from '../assets/roxy.png'
import type { MessagePart, MessageRole } from '@shared/types'
import { MessageParts } from './MessageParts'

/** Flatten a turn's text parts down to plain text (for user messages). */
function partsToText(parts: MessagePart[]): string {
  return parts.map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : '')).join('')
}

export function MessageBubble({
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
                  <img
                    key={i}
                    src={img.dataUrl}
                    alt={img.name ?? 'pasted image'}
                    className="max-h-48 max-w-[12rem] rounded-lg border border-border object-cover"
                  />
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
