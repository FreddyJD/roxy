<p align="center">
  <a href="https://roxy.gg">
    <img src="roxy.png" alt="Roxy" width="640" />
  </a>
</p>

# Roxy

> An open-source AI coding agent for engineers — built as a cross-platform desktop app.

**Download:** [https://roxy.gg](https://roxy.gg)

Roxy is an [Electron](https://www.electronjs.org/) application written in **TypeScript** with a
**React** renderer. It ships a full agent **harness** in the main process: a provider-agnostic
tool-calling loop, per-model tuned system prompts, Plan/Build agents and subagents, disk-backed
context management, and integrations for MCP servers, language-server diagnostics, and `SKILL.md`
skills.

## Tech stack

| Layer        | Choice                                  |
| ------------ | --------------------------------------- |
| Desktop      | Electron 33                             |
| Build tool   | electron-vite (Vite 5)                  |
| UI           | React 18 + TypeScript                   |
| Styling      | Tailwind CSS v4                         |
| Tool-calling | Vercel AI SDK (Anthropic + Google)      |
| Integrations | Model Context Protocol SDK              |
| Storage      | better-sqlite3                          |
| Packaging    | electron-builder                        |
| Formatting   | Prettier                                |

## Project structure

```
roxy/
├── build/                  # Packaging resources (icons, entitlements)
├── resources/              # Static assets bundled with the app
│   └── prompts/            # Tuned per-model + agent system prompts (inlined at build via ?raw)
├── src/
│   ├── main/               # Electron main process (Node.js)
│   │   ├── index.ts        # App lifecycle, window creation, service startup
│   │   ├── harness/        # The agent loop: agent.ts (loop + tool schemas), tools.ts (dispatch)
│   │   ├── services/       # llm.ts, aisdk.ts, mcp.ts, lsp.ts, skills.ts, browser.ts, loops.ts, …
│   │   ├── db/             # better-sqlite3 store: schema, migrations, repo
│   │   └── ipc/            # ipcMain handlers wiring the renderer to the harness/services
│   ├── preload/            # Secure bridge between main and renderer (window.api)
│   ├── renderer/           # React app (Chromium): routes, components, store
│   └── shared/             # Pure, cross-process modules: tools, agents, prompt/prompt-text,
│                           #   providers, context, tool-history, mcp, lsp, skills, web, types
├── test/                   # smoke.ts (Electron) + shared.ts (pure Node) validation suites
├── electron.vite.config.ts # Main / preload / renderer build config
└── electron-builder.yml    # Distribution config
```

## Getting started

```bash
# Install dependencies
npm install

# Run in development (hot reload)
npm run dev
```

## Useful scripts

| Script                  | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `npm run dev`           | Start the app with hot reload                  |
| `npm run build`         | Type-check and build for production            |
| `npm run typecheck`     | Type-check main, preload, and renderer         |
| `npm run smoke`         | Run the shared (Node) + app (Electron) suites  |
| `npm run format`        | Format the codebase with Prettier              |
| `npm run build:win`     | Build a Windows installer                      |
| `npm run build:mac`     | Build a macOS app                              |
| `npm run build:linux`   | Build Linux packages (AppImage, deb)           |

## Architecture notes

- **Context isolation is enabled** and `nodeIntegration` is off. The renderer talks to the main
  process only through the typed `window.api` bridge defined in [`src/preload`](src/preload/index.ts).
- IPC handlers live in [`src/main/ipc`](src/main/ipc/index.ts). Add a new renderer-facing capability
  by registering an `ipcMain.handle(...)` there and exposing a matching method in the preload bridge.

### Agent harness

The main process runs a single provider-agnostic agent loop; the renderer only streams events.

- **Tool loop** — [`src/main/harness/agent.ts`](src/main/harness/agent.ts) owns the turn loop, the
  tool JSON-schemas (`BASE_SCHEMAS`), context trimming, and subagent dispatch.
  [`tools.ts`](src/main/harness/tools.ts) is the authoritative `runTool` dispatcher. The user-facing
  catalog in [`src/shared/tools.ts`](src/shared/tools.ts) mirrors it (the "Skills & Tools" page) and
  is guarded against drift by the shared smoke suite.
- **Providers** — the hand-rolled OpenAI/Copilot SSE path (with Copilot's short-lived-token refresh)
  lives in [`services/llm.ts`](src/main/services/llm.ts); Anthropic + Google route through the Vercel
  AI SDK in [`services/aisdk.ts`](src/main/services/aisdk.ts) so every family gets tool-calling.
- **Prompts & agents** — tuned per-model prompts are selected in
  [`src/shared/prompt.ts`](src/shared/prompt.ts) and inlined from `resources/prompts/*.txt` via `?raw`
  in [`prompt-text.ts`](src/shared/prompt-text.ts). Plan/Build agents + subagents are defined in
  [`src/shared/agents.ts`](src/shared/agents.ts); an agent's `tools` allowlist and `promptFile` are
  what make Plan genuinely read-only.
- **Context management** — overflow is measured against the model's real limit
  ([`src/shared/context.ts`](src/shared/context.ts)); large tool outputs spill to disk with a preview
  pointer ([`services/tool-output-store.ts`](src/main/services/tool-output-store.ts)); older turns are
  summarized by [`services/compaction.ts`](src/main/services/compaction.ts).
- **Ecosystem** — external tool servers via the MCP client
  ([`services/mcp.ts`](src/main/services/mcp.ts)), language-server diagnostics fed back after edits
  ([`services/lsp.ts`](src/main/services/lsp.ts)), and on-demand `SKILL.md` skills
  ([`services/skills.ts`](src/main/services/skills.ts)). Roxy's own differentiators — the persistent
  browser toolset ([`services/browser.ts`](src/main/services/browser.ts)) and recurring "loops"
  ([`services/loops.ts`](src/main/services/loops.ts)) — run through the same loop.

### Remote Workspace

Take a running session to your phone. **Remote Workspace** (bottom-left **CUSTOMIZE** group in the
sidebar) mints a room on roxy.gg, shows a QR + safe URL + PIN, and keeps the desktop as the
authoritative host while a phone drives it as a thin client — **your code and files never leave the
machine**; only the chat transcript and streamed agent events are relayed.

- **Host service** — [`main/services/remote.ts`](src/main/services/remote.ts) mints via
  `POST https://roxy.gg/api/remote/sessions`, holds the **host token**, and keeps a host WebSocket
  alive (auto-reconnect w/ backoff). On a guest `hello` it sends a transcript snapshot; on a guest
  `prompt` it persists the message and runs the turn, fanning every `LlmEvent` to the phone **and**
  the local renderer. **Stop sharing** revokes the room (host-token `DELETE`).
- **One loop, no drift** — both the local `llm:start` IPC path and a remote prompt call the shared
  [`main/services/session-turn.ts`](src/main/services/session-turn.ts) `runSessionTurn`, so a phone
  prompt behaves identically to a local one.
- **IPC** — `remote:start | remote:stop | remote:status` + a `remote:state` push
  ([`src/shared/ipc.ts`](src/shared/ipc.ts)), handlers in
  [`src/main/ipc`](src/main/ipc/index.ts), bridge in [`src/preload`](src/preload/index.ts), types in
  [`src/shared/api.ts`](src/shared/api.ts). The QR popup is
  [`renderer/src/components/RemoteWorkspaceDialog.tsx`](src/renderer/src/components/RemoteWorkspaceDialog.tsx)
  (offline QR via `qrcode.react` — nothing leaves the machine).
- **Security** — no login: a short-lived HMAC guest token rides in the URL fragment and the phone
  must also enter the **PIN** shown on the desktop. The room (and its tokens) is revoked on Stop, on
  too many wrong PINs, at the TTL, or shortly after the desktop disconnects. See the relay + protocol
  details in the [roxy.gg README](../roxy.gg/README.md#remote-workspace).

## License

[MIT](LICENSE) © Roxy.

Roxy is a fork of [opencode](https://github.com/sst/opencode) (also MIT) and
retains opencode's copyright alongside Roxy's own. See [LICENSE](LICENSE) and
[`resources/prompts/ATTRIBUTION.txt`](resources/prompts/ATTRIBUTION.txt) for
details.
