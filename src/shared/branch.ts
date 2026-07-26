/**
 * Branch naming rules — pure, so they can be unit-tested without git or a
 * renderer (`npm run smoke:shared`) and shared by main and the UI.
 *
 * The UI must validate a branch name BEFORE spawning git: `git branch -m` on a
 * bad name is a 128 with a message written for a terminal, and the rename
 * dialog needs to disable its button while you type rather than explain a
 * fatal after the fact. Keeping the rules here means the check the button does
 * and the check the main process does can't drift apart.
 */

/** The default prefix for generated workstream branches. */
export const DEFAULT_BRANCH_PREFIX = 'roxy'

/** Hex length of a generated placeholder's suffix (`roxy/a1b2c3d4`). */
const PLACEHOLDER_HEX = 8

/**
 * Normalize a user-supplied prefix into the form the rest of the code expects:
 * no surrounding whitespace, no leading or trailing slashes.
 *
 * Empty means "no prefix" — a legitimate choice for people who want bare names
 * like `a1b2c3d4`, not a reason to silently reimpose `roxy`.
 */
export function normalizeBranchPrefix(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Is this prefix usable in a branch name?
 *
 * Deliberately stricter than git: a prefix is glued to generated names and to
 * a filesystem path (`worktreePathFor`), so the exotic-but-legal end of
 * `git check-ref-format` is more trouble than it is worth. Empty is valid.
 */
export function branchPrefixError(raw: string | null | undefined): string | null {
  const prefix = normalizeBranchPrefix(raw)
  if (!prefix) return null
  if (prefix.length > 40) return 'Too long (40 characters max).'
  if (!/^[A-Za-z0-9._\-/]+$/.test(prefix)) return 'Use letters, numbers, and . _ - / only.'
  if (prefix.includes('//')) return 'No empty path segments.'
  if (prefix.includes('..')) return 'No ".." in a branch name.'
  if (/(^|\/)[.-]/.test(prefix)) return 'Segments cannot start with "." or "-".'
  if (prefix.endsWith('.lock')) return 'Cannot end with ".lock".'
  return null
}

/**
 * Build a generated placeholder branch name from a prefix and a hex suffix.
 * Split from the random part so tests can pin the suffix.
 */
export function placeholderBranchName(prefix: string, hex: string): string {
  const clean = normalizeBranchPrefix(prefix)
  return clean ? `${clean}/${hex}` : hex
}

/**
 * Whether a branch is still an auto-generated placeholder for THIS prefix.
 *
 * Renaming a workstream's branch must only ever touch placeholders — clobbering
 * a name the user chose, or one that came from origin, is data loss. So this is
 * an exact shape (`<prefix>/` + 8 lowercase hex) rather than a prefix check:
 * `roxy/fix-auth` is a real name someone typed and must not qualify.
 */
export function isPlaceholderBranch(
  name: string | null | undefined,
  prefix: string = DEFAULT_BRANCH_PREFIX
): boolean {
  if (!name) return false
  const clean = normalizeBranchPrefix(prefix)
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = clean
    ? `^${escaped}/[0-9a-f]{${PLACEHOLDER_HEX}}$`
    : `^[0-9a-f]{${PLACEHOLDER_HEX}}$`
  return new RegExp(pattern).test(name)
}

/**
 * Why this branch name can't be used, or null if it's fine.
 *
 * Mirrors `git check-ref-format --branch` closely enough to catch everything a
 * person plausibly types, so the rename button can stay disabled with a reason
 * instead of round-tripping to git for a 128.
 */
export function branchNameError(raw: string | null | undefined): string | null {
  const name = (raw ?? '').trim()
  if (!name) return 'Enter a branch name.'
  if (name.length > 200) return 'Too long (200 characters max).'
  if (/\s/.test(name)) return 'No spaces — use - or _ instead.'
  if (/[~^:?*[\\]/.test(name)) return 'Cannot contain ~ ^ : ? * [ or \\.'
  if (/[\x00-\x1f\x7f]/.test(name)) return 'No control characters.'
  if (name.startsWith('/') || name.endsWith('/')) return 'Cannot start or end with "/".'
  if (name.includes('//')) return 'No empty path segments.'
  if (name.includes('..')) return 'No ".." in a branch name.'
  if (name.startsWith('-')) return 'Cannot start with "-".'
  if (name.endsWith('.') || name.endsWith('.lock')) return 'Cannot end with "." or ".lock".'
  if (/(^|\/)\./.test(name)) return 'Segments cannot start with ".".'
  if (name === '@') return '"@" is reserved.'
  if (name.includes('@{')) return 'Cannot contain "@{".'
  return null
}
