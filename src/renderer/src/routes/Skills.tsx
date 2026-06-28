import { useNavigate } from 'react-router-dom'
import { SKILLS } from '@shared/skills'
import type { SkillDef } from '@shared/types'
import { CatalogIcon } from '../lib/icons'
import { Badge } from '../components/ui'
import { PageShell } from '../components/PageShell'

export default function Skills(): JSX.Element {
  const navigate = useNavigate()
  const categories = [...new Set(SKILLS.map((s) => s.category))]

  return (
    <PageShell
      title="Skills & Tools"
      subtitle="Capabilities Roxy can use. Switch them on as they land."
      onBack={() => navigate('/')}
    >
      <div className="flex flex-col gap-7">
        {categories.map((category) => (
          <section key={category}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {category}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SKILLS.filter((s) => s.category === category).map((skill) => (
                <SkillCard key={skill.id} skill={skill} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageShell>
  )
}

function SkillCard({ skill }: { skill: SkillDef }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-text-muted">
        <CatalogIcon name={skill.icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{skill.name}</span>
          {skill.status === 'coming-soon' && <Badge>Soon</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">{skill.description}</p>
      </div>
    </div>
  )
}
