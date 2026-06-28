import {
  Code,
  Folder,
  GitBranch,
  Globe,
  Hash,
  Inbox,
  Mail,
  MessageCircle,
  MessagesSquare,
  Search,
  Send,
  Shield,
  Smartphone,
  Terminal,
  type LucideIcon
} from 'lucide-react'

/** Maps catalog icon names (from src/shared) to lucide components. */
const ICONS: Record<string, LucideIcon> = {
  send: Send,
  'message-circle': MessageCircle,
  hash: Hash,
  'messages-square': MessagesSquare,
  shield: Shield,
  smartphone: Smartphone,
  globe: Globe,
  'git-branch': GitBranch,
  mail: Mail,
  inbox: Inbox,
  folder: Folder,
  terminal: Terminal,
  search: Search,
  code: Code
}

export function CatalogIcon({
  name,
  className
}: {
  name: string
  className?: string
}): JSX.Element {
  const Cmp = ICONS[name] ?? Code
  return <Cmp className={className} />
}
