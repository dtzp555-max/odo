# ODO — OpenClaw Dashboard Orchestrator

A cross-platform desktop app for managing OpenClaw AI agents. Double-click to open — no terminal needed.

## Quick Start

```bash
git clone https://github.com/dtzp555-max/odo.git
cd odo
npm install
npm start
```

That's it. ODO will start the OCM server in the background, open a window, and put an icon in your system tray.

## What ODO does

- **Wraps OCM in a desktop app** — no browser tab, no terminal
- **System tray** — close the window and ODO keeps running; click the tray icon to reopen
- **Auto server management** — the OCM server starts and stops with the app
- **Crash recovery** — if the server dies, ODO offers to restart it

## Building for distribution

```bash
# macOS
npm run build:mac     # → dist/ODO-x.x.x.dmg

# Windows
npm run build:win     # → dist/ODO Setup x.x.x.exe

# Linux
npm run build:linux   # → dist/ODO-x.x.x.AppImage
```

## Project structure

```
odo/
├── main.js                       # Electron main process
├── preload.js                    # Renderer preload (IPC bridge)
├── server/
│   └── openclaw-manager.js       # OCM server (modified for Electron)
├── assets/
│   └── (icons go here)
├── package.json
└── README.md
```

## How it works

1. Electron's main process forks `server/openclaw-manager.js` as a child process
2. The server binds to `127.0.0.1:3333` (localhost only, for security)
3. Electron opens a BrowserWindow pointing to `http://127.0.0.1:3333`
4. The server sends an IPC message when it's ready; Electron shows the window
5. Closing the window hides it to the system tray; quitting from the tray stops everything

## Requirements

- Node.js 18+
- A working [OpenClaw](https://github.com/anthropics/openclaw) installation

## Updating the server

To sync with the latest OCM:

```bash
# From the odo directory
cp /path/to/ocm/openclaw-manager.js server/openclaw-manager.js
```

Then re-apply the two small Electron patches (search for `ELECTRON` in the file):
1. Skip `openBrowser()` when `process.env.ELECTRON` is set
2. Force `HOST = '127.0.0.1'` when `process.env.ELECTRON` is set
3. Send IPC ready message: `if (process.send) process.send({ type: 'server-ready', port: PORT })`

## Roadmap

See `ODO_ARCHITECTURE.md` for the full product vision and phased plan.

## License

MIT
