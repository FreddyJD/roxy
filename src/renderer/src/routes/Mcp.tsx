import { useNavigate } from 'react-router-dom'
import { McpServers } from '../components/McpServers'
import { PageShell } from '../components/PageShell'

export default function Mcp(): JSX.Element {
  const navigate = useNavigate()
  return (
    <PageShell
      title="MCP Servers"
      subtitle="Connect external Model Context Protocol tool servers (filesystem, GitHub, databases, browsers, …) to expand what Roxy can do. Servers are also read from a workspace .roxy/mcp.json, and the agent can add them itself with the mcp tool."
      onBack={() => navigate('/')}
    >
      <McpServers />
    </PageShell>
  )
}
