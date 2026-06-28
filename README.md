# Roxy

> An open-source AI coding agent for engineers — built as a cross-platform desktop app.

Roxy is an [Electron](https://www.electronjs.org/) application written in **TypeScript** with a
**React** renderer. This repository is the foundation; the agent tooling and capabilities are layered
on top of this scaffold.

## Tech stack

| Layer        | Choice                                  |
| ------------ | --------------------------------------- |
| Desktop      | Electron 33                             |
| Build tool   | electron-vite (Vite 5)                  |
| UI           | React 18 + TypeScript                   |
| Styling      | Tailwind CSS v4                         |
| Packaging    | electron-builder                        |
| Formatting   | Prettier                                |

## Project structure

```
roxy/
├── build/                  # Packaging resources (icons, entitlements)
├── resources/              # Static assets bundled with the app (app icon)
├── src/
│   ├── main/               # Electron main process (Node.js)
│   │   └── index.ts        # App lifecycle, window creation, IPC handlers
│   ├── preload/            # Secure bridge between main and renderer
│   │   ├── index.ts        # contextBridge API surface (window.api)
│   │   └── index.d.ts      # Renderer-side type definitions
│   └── renderer/           # React app (Chromium)
│       ├── index.html
│       └── src/
│           ├── main.tsx    # React entry point
│           ├── App.tsx     # Root component
│           ├── assets/     # CSS and images
│           └── components/ # UI components
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
| `npm run format`        | Format the codebase with Prettier              |
| `npm run build:win`     | Build a Windows installer                      |
| `npm run build:mac`     | Build a macOS app                              |
| `npm run build:linux`   | Build Linux packages (AppImage, deb)           |

## Architecture notes

- **Context isolation is enabled** and `nodeIntegration` is off. The renderer talks to the main
  process only through the typed `window.api` bridge defined in [`src/preload`](src/preload/index.ts).
- IPC handlers live in [`src/main/index.ts`](src/main/index.ts). Add new agent capabilities by
  registering an `ipcMain.handle(...)` there and exposing a matching method in the preload bridge.

## License

[MIT](LICENSE)
