import { useRoxyStore } from '../lib/store'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { TerminalView } from '../components/TerminalView'

export default function Chat(): JSX.Element {
  const activeTerminalId = useRoxyStore((s) => s.activeTerminalId)
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      {activeTerminalId ? <TerminalView id={activeTerminalId} /> : <ChatView />}
    </div>
  )
}
