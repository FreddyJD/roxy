import { memo } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { ToolDiff } from '@shared/types'

/**
 * Before/after file diff for a write/edit tool card, rendered with
 * @pierre/diffs (Shiki syntax highlighting, isolated in shadow DOM). This is a
 * default export so it can be lazy-loaded — Shiki only ships when a diff card
 * is actually expanded. Wrapped in `memo` so it never re-highlights on an
 * unrelated parent re-render (its props are plain strings).
 */
function FileDiffView({ path, before, after }: ToolDiff): JSX.Element {
  const name = path.split(/[\\/]/).pop() || path
  return (
    <div style={{ ['--diffs-font-size' as string]: '12px' }}>
      <MultiFileDiff
        oldFile={{ name, contents: before }}
        newFile={{ name, contents: after }}
        // Highlight synchronously on the main thread. The default worker pool
        // can't bundle/spawn its worker in the Electron + Vite renderer, and its
        // async init was racing on first mount — the card opened blank until you
        // re-clicked it. Our content is size-capped upstream, so main-thread
        // highlighting is a bounded, one-time cost on expand.
        disableWorkerPool
        options={{
          theme: { dark: 'pierre-dark', light: 'pierre-light' },
          themeType: 'dark',
          diffStyle: 'unified',
          diffIndicators: 'bars',
          // The tool card already shows the file name — drop the diff's own header.
          disableFileHeader: true,
          // Performance for large files: render only the changed hunks (+ a few
          // context lines) instead of every unchanged line, and bound how much
          // Shiki tokenizes (huge / minified files degrade to plain text
          // instead of locking up).
          expandUnchanged: false,
          collapsedContextThreshold: 3,
          tokenizeMaxLineLength: 2000,
          tokenizeMaxLength: 200_000
        }}
      />
    </div>
  )
}

export default memo(FileDiffView)
