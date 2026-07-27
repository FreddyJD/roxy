import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useRoxyStore } from './lib/store'
import roxy from './assets/roxy.png'
import Onboarding from './routes/Onboarding'
import Chat from './routes/Chat'
import Integrations from './routes/Integrations'
import Skills from './routes/Skills'
import Mcp from './routes/Mcp'
import Settings from './routes/Settings'

function Splash(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg">
      <img
        src={roxy}
        alt="Roxy"
        className="h-14 w-14 animate-pulse rounded-2xl object-cover ring-1 ring-border"
      />
    </div>
  )
}

export default function App(): JSX.Element {
  const ready = useRoxyStore((s) => s.ready)
  const settings = useRoxyStore((s) => s.settings)
  const bootstrap = useRoxyStore((s) => s.bootstrap)

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  if (!ready) return <Splash />

  const onboarded = settings?.onboardingCompleted ?? false

  return (
    <HashRouter>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/" element={onboarded ? <Chat /> : <Navigate to="/onboarding" replace />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/skills" element={<Skills />} />
        <Route path="/mcp" element={<Mcp />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
