import { memo } from 'react'
import { File } from '@pierre/diffs/react'

/**
 * Renders a single file's contents syntax-highlighted via @pierre/diffs (the
 * same renderer the diff view uses) — used to show `read` tool output as proper
 * code instead of a plain <pre>. Default export so it can be lazy-loaded;
 * wrapped in `memo` (props are plain strings) so it doesn't re-highlight on an
 * unrelated parent re-render.
 */
function FileView({ name, contents }: { name: string; contents: string }): JSX.Element {
  return (
    <div style={{ ['--diffs-font-size' as string]: '12px' }}>
      <File
        file={{ name, contents }}
        // Main-thread highlight (the default worker pool races on first mount in
        // Electron + Vite and left the card blank until a re-click).
        disableWorkerPool
        options={{
          theme: { dark: 'pierre-dark', light: 'pierre-light' },
          themeType: 'dark',
          // The tool card title already shows the file name.
          disableFileHeader: true,
          // Bound tokenization so a huge or minified file degrades to plain text
          // instead of locking the thread.
          tokenizeMaxLineLength: 2000,
          tokenizeMaxLength: 200_000
        }}
      />
    </div>
  )
}

export default memo(FileView)
