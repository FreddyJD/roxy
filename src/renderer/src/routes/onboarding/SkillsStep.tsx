import { SKILLS } from '@shared/skills'
import { CatalogIcon } from '../../lib/icons'
import { Badge } from '../../components/ui'

export function SkillsStep(): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Pick your skills <span className="text-text-subtle">(optional)</span>
      </h1>
      <p className="mt-2 text-sm text-text-muted">
        Tools Roxy can use. Some are ready now; the rest are on the roadmap and switch on as they
        land.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SKILLS.map((skill) => (
          <div
            key={skill.id}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4"
          >
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
        ))}
      </div>
    </div>
  )
}
