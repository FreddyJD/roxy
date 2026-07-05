/**
 * Fun, human-readable session names — the npm/Docker "random release name" trick,
 * but themed. New sessions land as e.g. "Async Roxy Sage" or "Crimson Goblin
 * Slayer" instead of "Session 3"; the agent renames them properly on its first
 * turn (change_session_metadata), so this is just a friendlier placeholder.
 *
 * Three curated pools — adjective + noun + role — so any random combination still
 * reads like a title. Flavors mix, on purpose:
 *   - Mushoku Tensei: Jobless Reincarnation (the app *is* named after Roxy) 🪄
 *   - tabletop / RPG fantasy (goblins, mages, slayers)
 *   - computer-science-y words (async, kernel, lambda, daemon)
 */

/** First word — an adjective/modifier (fantasy + comp-sci + a couple MT nods). */
const ADJECTIVES = [
  'Async',
  'Recursive',
  'Volatile',
  'Static',
  'Lazy',
  'Eager',
  'Nested',
  'Cached',
  'Forked',
  'Threaded',
  'Quantum',
  'Atomic',
  'Concurrent',
  'Verbose',
  'Legacy',
  'Crimson',
  'Azure',
  'Golden',
  'Silent',
  'Frozen',
  'Ancient',
  'Hidden',
  'Arcane',
  'Cursed',
  'Blessed',
  'Feral',
  'Phantom',
  'Void',
  'Wandering',
  'Reckless',
  'Brave',
  'Jobless',
  'Reincarnated',
  'Immortal',
  'Turbo',
  'Rusty'
] as const

/** Second word — a noun: MT characters/tribes/places, creatures, comp-sci nouns. */
const NOUNS = [
  // Mushoku Tensei — characters
  'Roxy',
  'Rudeus',
  'Eris',
  'Sylphie',
  'Ghislaine',
  'Ruijerd',
  'Orsted',
  'Nanahoshi',
  'Perugius',
  'Zanoba',
  'Kishirika',
  'Hitogami',
  // Mushoku Tensei — tribes / places
  'Fittoa',
  'Asura',
  'Millis',
  'Ranoa',
  'Migurd',
  'Superd',
  // Fantasy creatures
  'Goblin',
  'Dragon',
  'Ogre',
  'Wyvern',
  'Golem',
  'Basilisk',
  'Lich',
  'Phoenix',
  'Griffin',
  'Demon',
  // Comp-sci nouns
  'Kernel',
  'Buffer',
  'Vector',
  'Lambda',
  'Daemon',
  'Thread',
  'Pointer',
  'Cipher',
  'Token',
  'Syntax',
  'Mutex',
  'Socket',
  'Matrix',
  'Sentinel',
  'Proxy',
  'Mana'
] as const

/** Third word — a role/rank: RPG classes + MT magic tiers + comp-sci suffixes. */
const ROLES = [
  // RPG classes
  'Slayer',
  'Mage',
  'Sage',
  'Knight',
  'Wizard',
  'Summoner',
  'Sorcerer',
  'Warden',
  'Hunter',
  'Ranger',
  'Scholar',
  'Paladin',
  'Berserker',
  'Swordsman',
  'Apprentice',
  'Adept',
  // Mushoku Tensei magic ranks (Roxy's a Saint/King-tier Water mage)
  'Saint',
  'King',
  'Emperor',
  'God',
  // Comp-sci suffixes
  'Compiler',
  'Runtime',
  'Handler',
  'Parser',
  'Loader',
  'Scheduler',
  'Debugger',
  'Protocol',
  'Process',
  'Overflow'
] as const

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

/** A random three-word title, e.g. "Async Roxy Sage" or "Crimson Goblin Slayer". */
export function randomSlug(): string {
  const adjective = pick(ADJECTIVES)
  const noun: string = pick(NOUNS)
  let role: string = pick(ROLES)
  // The pools don't currently overlap, but guard anyway so a future shared word
  // (e.g. adding "Daemon" to both) can never yield an awkward "Feral Daemon Daemon".
  while (role === noun) role = pick(ROLES)
  return `${adjective} ${noun} ${role}`
}

/**
 * A random slug that isn't already `taken` (case-insensitive) — used so two
 * sessions in the same project don't collide. Falls back to a numeric suffix in
 * the (astronomically unlikely) event we can't find a free combo.
 */
export function uniqueSlug(taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (t) => t.toLowerCase()))
  for (let i = 0; i < 50; i++) {
    const slug = randomSlug()
    if (!used.has(slug.toLowerCase())) return slug
  }
  return `${randomSlug()} ${Math.floor(Math.random() * 900 + 100)}`
}
