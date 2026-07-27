import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { api } from '../lib/api'
import { Button } from '../components/ui'
import roxy from '../assets/roxy.png'
import { WelcomeStep } from './onboarding/WelcomeStep'
import { ProviderStep } from './onboarding/ProviderStep'

type Step = 'welcome' | 'provider'

export default function Onboarding(): JSX.Element {
  const navigate = useNavigate()
  const providers = useRoxyStore((s) => s.providers)
  const bootstrap = useRoxyStore((s) => s.bootstrap)
  const [step, setStep] = useState<Step>('welcome')
  const [finishing, setFinishing] = useState(false)

  const canFinish = providers.length > 0

  const finish = async (): Promise<void> => {
    setFinishing(true)
    await api.settings.completeOnboarding()
    await bootstrap()
    navigate('/')
  }

  // The welcome screen is full-bleed artwork: no header chrome or footer, just
  // a draggable strip so the window still moves.
  if (step === 'welcome') {
    return (
      <div className="relative h-full w-full bg-bg">
        <div className="titlebar absolute inset-x-0 top-0 z-10 h-14" />
        <WelcomeStep onContinue={() => setStep('provider')} />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="titlebar reserve-controls-left reserve-controls-right flex h-14 shrink-0 items-center px-5">
        <div className="flex items-center gap-2.5">
          <img
            src={roxy}
            alt="Roxy"
            className="h-7 w-7 rounded-lg object-cover ring-1 ring-border"
          />
          <span className="text-sm font-semibold">Roxy</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <ProviderStep />
        </div>
      </div>

      <footer className="flex h-16 shrink-0 items-center justify-between border-t border-border px-6">
        <span className="text-xs text-text-subtle">
          {canFinish
            ? 'Nice — you can add more providers anytime in Settings.'
            : 'Add an AI provider to get started.'}
        </span>
        <Button variant="primary" onClick={finish} disabled={!canFinish || finishing}>
          {finishing ? 'Finishing…' : 'Continue'}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </footer>
    </div>
  )
}
