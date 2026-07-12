/**
 * Model-selection helpers shared by the renderer, the remote host, and the
 * onboarding connect flow. models.dev already returns each provider's list
 * newest-first, so "use the latest model" is just "take the first" — preferring
 * a tool-capable one, since Roxy is an agent that calls tools every turn.
 */
import type { ModelInfo } from './api'

/**
 * Pick a sensible default model from a provider's catalog so a freshly connected
 * provider "just works" without the user typing a model name: the newest
 * tool-capable model, else the newest model overall. Returns undefined only when
 * the catalog is empty (offline, or a provider models.dev doesn't know).
 */
export function pickDefaultModel(models: ModelInfo[]): string | undefined {
  if (models.length === 0) return undefined
  const toolCapable = models.find((m) => m.toolCall)
  return (toolCapable ?? models[0]).id
}
