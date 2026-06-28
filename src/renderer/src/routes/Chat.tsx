import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'

export default function Chat(): JSX.Element {
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <ChatView />
    </div>
  )
}
