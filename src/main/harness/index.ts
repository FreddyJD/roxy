/**
 * The harness — where Roxy runs an agent session. It owns the loop that drives a
 * session to completion: build the system prompt for the chosen agent, call the
 * model, dispatch tool calls, append results, and repeat (and, for sub-sessions,
 * spawn subagents via the `task` tool).
 *
 * Today it exposes the tool dispatch (`runTool`); the model loop plugs in here so
 * tool calling lives inside the harness rather than as a standalone IPC.
 */
export { runTool, killAllBackground, type ToolContext } from './tools'
export { runAgentTurn, type RunTurnOptions } from './agent'
