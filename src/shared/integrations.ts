import type { IntegrationDef } from './types'

/**
 * Messaging surfaces Roxy's chat can be reached from (OpenClaw-style).
 * All "coming soon" for now — onboarding lets users opt in early.
 */
export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to Roxy from a Telegram bot.',
    status: 'coming-soon',
    icon: 'send',
    accent: '#2AABEE'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Message Roxy on WhatsApp.',
    status: 'coming-soon',
    icon: 'message-circle',
    accent: '#25D366'
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Bring Roxy into your Slack workspace.',
    status: 'coming-soon',
    icon: 'hash',
    accent: '#611F69'
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Run Roxy as a Discord bot.',
    status: 'coming-soon',
    icon: 'messages-square',
    accent: '#5865F2'
  },
  {
    id: 'signal',
    name: 'Signal',
    description: 'Private messaging with Roxy on Signal.',
    status: 'coming-soon',
    icon: 'shield',
    accent: '#3A76F0'
  },
  {
    id: 'sms',
    name: 'SMS',
    description: 'Text Roxy over SMS.',
    status: 'coming-soon',
    icon: 'smartphone',
    accent: '#22C55E'
  }
]
