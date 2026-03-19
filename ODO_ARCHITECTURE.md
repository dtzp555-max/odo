# ODO — OpenClaw Dashboard Orchestrator

## Architecture Design Document

> Version: Draft 1.0
> Date: 2026-03-18
> Status: Proposal — pending review

---

## 1. Product Overview

### What is ODO?

ODO is the desktop app evolution of OCM (OpenClaw Manager). It is a cross-platform Electron application that lets users manage one or more OpenClaw instances — local or remote — from a single window.

### One-line pitch

**"Double-click to manage all your OpenClaw agents, on this machine or any other."**

### Who is ODO for?

- People already running OpenClaw who want visual control instead of hand-editing JSON
- People running OpenClaw on multiple machines (home server, VPS, NAS) who want one place to manage them all
- Power users who still want a built-in CLI but prefer a desktop app over a browser tab

### Who is ODO not for?

- People who have never installed OpenClaw (ODO is not an installer)
- People who want a chat UI for talking to agents (that's ClawX / ClawUI territory)
- People who want a cloud-hosted SaaS dashboard

---

## 2. Competitive Positioning

| Product | Type | Focus | Weakness (ODO's opportunity) |
|---------|------|-------|------------------------------|
| ClawX | Desktop (Electron) | Chat client, talking to agents | No ops/config management |
| ClawUI | Desktop (Electron) | Chat + session inspection | No backup, no multi-instance |
| TenacitOS | Web dashboard | Cost analytics, monitoring | Web-only, no desktop, no remote |
| ClawBoard | Web dashboard | Agent management | Web-only, local only |
| VidClaw | Web dashboard | Kanban + file editing | Local only, no remote |
| Claworc | Web platform | Enterprise multi-instance | Requires Docker/K8s, overkill for individuals |
| **ODO** | **Desktop (Electron)** | **Ops control + remote management** | — |

### ODO's unique value

1. **Multi-instance**: manage local + remote OpenClaw from one window
2. **Ops-first**: backup/restore, health, logs, gateway control — not just monitoring
3. **Configuration editor**: visual tool/plugin management instead of JSON editing
4. **Disaster recovery**: versioned config snapshots + remote backup

---

## 3. Feature Specification

### 3.1 Core Features (daily use)

#### Dashboard
- System health: CPU, RAM, disk gauges
- Gateway status: running/stopped, PID, uptime
- Agent overview: count, last activity, binding summary
- Quick actions: restart gateway, open logs
- Auto-refresh toggle (10s interval)
- **NEW**: Connection selector — switch between local and remote instances

#### Agents Console
- Agent tree: visual hierarchy of main agents and sub-agents
- Per-agent details: bound channels/groups/threads, model, workspace path
- Inline model switching (dropdown, save without rebuild)
- Workspace file browser: view and edit SOUL.md, MEMORY.md, config files
- **EVOLVED**: De-emphasize "Add Sub-Agent" wizard. The main use case is now:
  - View current agent structure (read-heavy)
  - Manually adjust model, tools, plugins per agent
  - Edit personality/memory files
  - Agent creation still available but no longer the hero flow

#### Stats (Token Cost Monitor)
- Parse session JSONL files for real token usage
- Breakdown: by model, by agent, by day
- Visual charts: daily bar chart, model pie chart
- Time range filter: 1d / 7d / 30d / 90d
- Custom model pricing (stored in local config)
- **Borrow from TenacitOS**: trend lines, cost prediction

### 3.2 Professional Features (when needed)

#### CLI Terminal
- Full-width terminal panel, expandable from bottom dock
- Real-time streaming output (chunked HTTP)
- Tab completion: OpenClaw subcommands + history + presets
- Saved favorites (user-defined frequent commands)
- Preset command library (15+ common operations)
- **Keep as-is**: this is a differentiator, power users love it

#### Log Viewer (NEW)
- Real-time gateway log streaming (tail -f style)
- Log level filter: ERROR / WARN / INFO / DEBUG
- Text search within logs
- Auto-scroll with pause-on-scroll
- Timestamp display (Brisbane timezone or user preference)
- Log file selector (gateway.log, agent session logs)
- Export / copy selected log range

#### Backup & Recovery
- **Local backup**: one-click snapshot of openclaw.json + agent configs to a local directory
- **Remote backup**: SFTP/SCP to a remote server (simplified from OCM's NAS module)
  - Host, port, username, auth (password or SSH key)
  - One-click test connection
  - One-click backup now
  - Scheduled backup (daily, via system scheduler integration)
- **Config version history**: every config change creates a timestamped snapshot
  - Version list with diff view (before/after comparison)
  - One-click rollback to any version
  - Auto-cleanup: keep last 50 versions, older ones auto-pruned
- **Remote backup simplification vs OCM**:
  - Remove: old NAS CBC cipher compatibility (too niche)
  - Remove: SSH key generation UI (users should manage keys externally)
  - Keep: password auth, key auth, test connection, backup now, scheduled backup
  - Add: backup to any SSH-accessible server (not just NAS)

#### Routing (formerly Channels)
- View all channel bindings grouped by agent
- Expand/collapse per agent
- Add/remove bindings
- Support: Telegram groups, Discord channels/threads
- Agent filter (all agents / specific agent)

#### Models & Auth
- Primary model selector (from `openclaw models list`)
- Fallback chain editor
- Provider auth status overview
- Auth setup guides per provider (click-to-copy CLI commands)

### 3.3 Desktop App Capabilities (NEW)

#### System Tray
- App icon in system tray (macOS menu bar / Windows system tray / Linux indicator)
- Closing the window minimizes to tray (does not quit)
- Tray menu: Show Window, Gateway Status, Restart Gateway, Quit
- Status indicator: green dot (healthy) / red dot (gateway down)

#### Gateway Lifecycle Management
- On app launch: auto-start local OpenClaw gateway if not already running
- On app quit: optionally stop gateway (user preference)
- Gateway crash detection: notification + one-click restart
- Option: "Keep gateway running after ODO closes" (for server use)

#### Auto-Start
- Option to launch ODO on system login
- Uses: macOS Login Items / Windows Registry / Linux autostart

#### Auto-Update
- Check for updates on launch (GitHub Releases)
- Download + install in background
- Notification: "Update available — restart to apply"
- Uses: electron-updater

#### Multi-Instance Connection Manager (NEW — key differentiator)
- Connection list: save multiple OpenClaw instances
  - Name (e.g., "Home Server", "VPS", "Local")
  - Type: Local (filesystem) or Remote (WebSocket)
  - For remote: host, port (18789), auth token
  - Connection status indicator
- Switch between instances from the top bar
- All features work identically for local and remote instances
- Remote protocol: OpenClaw Gateway WebSocket API
- Connection security: token auth, optional SSH tunnel instructions

---

## 4. Technical Architecture

### 4.1 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Desktop shell | Electron 33+ | Cross-platform, mature, largest ecosystem |
| Frontend | React 19 + TypeScript | Component-based, maintainable, huge community |
| UI framework | Tailwind CSS 4 | Utility-first, fast iteration, no custom CSS sprawl |
| Charts | Recharts | React-native charting, lightweight |
| Build tool | Vite | Fast dev server, HMR, clean builds |
| Packaging | electron-builder | .dmg / .exe / .AppImage in one command |
| Auto-update | electron-updater | GitHub Releases integration |
| Backend (main process) | Node.js (Electron built-in) | Reuse OCM server logic |

### 4.2 Process Architecture

```
┌──────────────────────────────────────────────┐
│                 Electron                       │
│                                                │
│  ┌──────────────────┐  ┌───────────────────┐  │
│  │  Main Process     │  │  Renderer Process  │  │
│  │  (Node.js)        │  │  (React App)       │  │
│  │                   │  │                    │  │
│  │  - HTTP Server    │◄─┤  - Dashboard       │  │
│  │  - File I/O       │  │  - Agents Console  │  │
│  │  - child_process  │  │  - Stats           │  │
│  │  - Gateway mgmt   │  │  - CLI Terminal    │  │
│  │  - Backup engine  │  │  - Log Viewer      │  │
│  │  - Remote connect │  │  - Backup UI       │  │
│  │  - System tray    │  │  - Settings        │  │
│  │                   │  │                    │  │
│  │  IPC Bridge ──────┤──┤── IPC Bridge       │  │
│  └──────────────────┘  └───────────────────┘  │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │  OpenClaw Gateway (child process or remote)│  │
│  └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Main Process** handles:
- All filesystem operations (read/write openclaw.json, logs, backups)
- Spawning OpenClaw CLI commands
- Gateway process lifecycle
- Remote WebSocket connections to other OpenClaw instances
- System tray management
- Auto-update checks

**Renderer Process** handles:
- All UI rendering (React components)
- User interactions
- Communicates with Main Process via Electron IPC

**Why keep the HTTP server?**
The existing OCM API layer (`GET /api/dashboard`, `POST /api/agents`, etc.) is well-tested. Rather than rewriting everything as IPC handlers from scratch, we wrap the existing HTTP API in the main process and call it from the renderer. This lets us:
1. Reuse all existing backend logic
2. Add IPC gradually (replace HTTP calls with IPC one module at a time)
3. Keep the option of remote web access (start HTTP server on a port for LAN access)

### 4.3 IPC Communication

```
Renderer (React)                    Main Process (Node.js)
     │                                      │
     │── ipcRenderer.invoke('api', {        │
     │     method: 'GET',                   │
     │     path: '/api/dashboard'           │
     │   })                                 │
     │                                      │
     │◄── { status: 200, data: {...} } ─────│
     │                                      │
     │── ipcRenderer.invoke('gateway',      │
     │     { action: 'restart' })           │
     │                                      │
     │◄── { ok: true, pid: 12345 } ────────│
```

IPC channels:
- `api` — proxy to internal HTTP API (backward compatible with OCM)
- `gateway` — gateway lifecycle (start/stop/restart/status)
- `backup` — backup operations (snapshot/restore/remote-push)
- `connection` — remote instance management (connect/disconnect/list)
- `system` — app-level (auto-update, tray, preferences)
- `cli` — terminal command execution with streaming output
- `logs` — log file streaming (subscribe/unsubscribe)

### 4.4 Remote Connection Architecture

```
┌─────────────────┐         ┌──────────────────────────┐
│  ODO (Desktop)   │         │  Remote Machine           │
│                  │         │                           │
│  Connection Mgr  │◄──WSS──┤  OpenClaw Gateway         │
│  │               │   :18789│  (ws://127.0.0.1:18789)  │
│  └─► Dashboard   │         │                           │
│  └─► Agents      │         │  Accessed via:            │
│  └─► Stats       │         │  - Direct LAN/Tailscale   │
│  └─► Logs        │         │  - SSH tunnel              │
│                  │         │                           │
└─────────────────┘         └──────────────────────────┘
```

For remote instances:
- ODO connects to the Gateway WebSocket API directly
- Auth: token-based (`gateway.remote.token`)
- Features available remotely: Dashboard, Agents (read), Stats, Logs, CLI (commands proxied)
- Features local-only: Backup to local disk, Gateway process management

---

## 5. Project Structure

```
odo/
├── package.json
├── electron-builder.yml          # Build/packaging config
├── vite.config.ts                # Vite config for renderer
├── tsconfig.json
│
├── src/
│   ├── main/                     # Electron main process
│   │   ├── index.ts              # App entry, window creation, tray
│   │   ├── ipc/                  # IPC handlers
│   │   │   ├── api.ts            # HTTP API proxy (from OCM)
│   │   │   ├── gateway.ts        # Gateway lifecycle
│   │   │   ├── backup.ts         # Backup engine
│   │   │   ├── connection.ts     # Remote instance manager
│   │   │   ├── cli.ts            # CLI command runner
│   │   │   └── logs.ts           # Log streaming
│   │   ├── server/               # Migrated OCM backend
│   │   │   ├── api-routes.ts     # All /api/* handlers
│   │   │   ├── openclaw-config.ts # openclaw.json reader/writer
│   │   │   ├── stats-parser.ts   # Session JSONL parser
│   │   │   └── health.ts         # openclaw doctor wrapper
│   │   ├── services/
│   │   │   ├── tray.ts           # System tray
│   │   │   ├── auto-update.ts    # electron-updater
│   │   │   ├── auto-launch.ts    # Login item registration
│   │   │   └── gateway-manager.ts # Start/stop/monitor gateway
│   │   └── utils/
│   │       ├── paths.ts          # OS-specific path resolution
│   │       ├── timestamp.ts      # Brisbane timezone helper
│   │       └── backup-utils.ts   # Snapshot/restore helpers
│   │
│   ├── renderer/                 # React frontend
│   │   ├── index.html
│   │   ├── main.tsx              # React entry
│   │   ├── App.tsx               # Root component, routing
│   │   ├── api/                  # IPC client wrappers
│   │   │   └── client.ts         # invoke('api', ...) helper
│   │   ├── components/           # Shared UI components
│   │   │   ├── Layout.tsx        # App shell: sidebar + header + main
│   │   │   ├── Sidebar.tsx       # Navigation
│   │   │   ├── ConnectionPicker.tsx  # Instance switcher (top bar)
│   │   │   ├── StatusBadge.tsx
│   │   │   └── Toast.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Agents.tsx
│   │   │   ├── Stats.tsx
│   │   │   ├── Logs.tsx          # NEW
│   │   │   ├── CLI.tsx
│   │   │   ├── Routing.tsx
│   │   │   ├── ModelsAuth.tsx
│   │   │   ├── Backup.tsx
│   │   │   └── Settings.tsx      # NEW: preferences, connections, auto-start
│   │   ├── hooks/
│   │   │   ├── useApi.ts         # Data fetching hook
│   │   │   ├── useGateway.ts     # Gateway status hook
│   │   │   └── useConnection.ts  # Active connection hook
│   │   └── styles/
│   │       └── globals.css       # Tailwind imports + dark theme vars
│   │
│   ├── shared/                   # Types shared between main & renderer
│   │   ├── types.ts
│   │   └── constants.ts
│   │
│   └── preload/
│       └── index.ts              # Electron preload script (IPC bridge)
│
├── resources/                    # App icons, installer assets
│   ├── icon.icns                 # macOS
│   ├── icon.ico                  # Windows
│   └── icon.png                  # Linux
│
├── scripts/
│   └── migrate-ocm.ts           # Helper: extract API logic from OCM single file
│
└── legacy/
    └── openclaw-manager.js       # Original OCM for reference during migration
```

---

## 6. UI Design Direction

### Layout

```
┌──────────────────────────────────────────────────────┐
│  [ODO icon]  [Connection: Local ▾]    [🔴 Gateway]   │
├────────┬─────────────────────────────────────────────┤
│        │                                              │
│  🏠    │          Main Content Area                   │
│  Dashboard                                            │
│        │          (selected page renders here)        │
│  🤖    │                                              │
│  Agents│                                              │
│        │                                              │
│  📊    │                                              │
│  Stats │                                              │
│        │                                              │
│  📋    │                                              │
│  Logs  │                                              │
│        │                                              │
│  ⚙️    │                                              │
│  Routing                                              │
│        │                                              │
│  🔑    │                                              │
│  Auth  │                                              │
│        │                                              │
│  💾    │                                              │
│  Backup│                                              │
│        │                                              │
│  ⚙️    │                                              │
│ Settings                                              │
│        │                                              │
├────────┴─────────────────────────────────────────────┤
│  [> _] CLI Terminal (expandable dock)                 │
└──────────────────────────────────────────────────────┘
```

### Design principles

1. **Dark theme default** — inherit OCM's dark palette (#0f1117 bg, #6c63ff accent)
2. **Sidebar navigation** — always visible, icon + label, collapsible on narrow windows
3. **Top bar** — connection picker (local/remote), gateway status badge
4. **Bottom dock** — CLI terminal, click to expand, drag to resize
5. **Dense but readable** — avoid excessive whitespace, show more data per screen
6. **No page reloads** — SPA with client-side routing

---

## 7. Migration Strategy

### Phase 0: Scaffolding (Week 1)
**Goal: Empty Electron app that opens a window**
- Initialize project: `npm create electron-vite@latest`
- Set up: TypeScript, React, Tailwind, Vite
- Create window with app shell (sidebar + empty main area)
- System tray with Quit option
- Build and package for macOS (.dmg)
- Verify: double-click .dmg → install → double-click app → window opens

### Phase 1: Dashboard + Gateway (Week 2)
**Goal: See system health and control gateway**
- Migrate OCM's `/api/dashboard` logic to main process
- Build Dashboard page (React): gauges, system info, gateway status
- IPC: gateway start/stop/restart
- Auto-start gateway on app launch
- Connection to local OpenClaw directory (auto-detect or setup wizard)

### Phase 2: Agents + Workspace (Week 3)
**Goal: View and configure agents**
- Migrate OCM's agent tree rendering to React components
- Agent tree: collapsible, grouped by parent
- Per-agent: model selector, binding overview
- Workspace file browser: list files, view content, edit and save
- Migrate: `/api/agents`, `/api/workspace` endpoints

### Phase 3: Stats + Logs (Week 4)
**Goal: Monitor costs and debug issues**
- Migrate OCM's stats parser (session JSONL)
- Stats page: charts (Recharts), filters, model breakdown
- NEW: Log viewer page
  - Stream gateway.log via IPC
  - Level filter, text search, auto-scroll
  - Agent session log selector

### Phase 4: CLI + Routing + Auth (Week 5)
**Goal: Power user tools**
- CLI terminal: command input, streaming output, tab completion, presets
- Routing page: binding list, add/remove, agent filter
- Models & Auth page: model selector, fallback chain, provider guides

### Phase 5: Backup & Recovery (Week 6)
**Goal: Disaster recovery**
- Config version history: auto-snapshot on every change, diff viewer
- One-click rollback
- Local backup to user-specified directory
- Remote backup: SFTP/SCP with simplified setup
  - Connection form: host, port, user, auth method, remote path
  - Test connection, backup now, schedule (daily)
- Scheduled backup via OS scheduler (cron on macOS/Linux, Task Scheduler on Windows)

### Phase 6: Remote Management (Week 7-8)
**Goal: Manage OpenClaw on other machines**
- Connection manager: add/edit/remove remote instances
- WebSocket client for OpenClaw Gateway API
- Auth: token-based
- Adapt all pages to work with remote data source
- Connection picker in top bar
- Handle disconnection gracefully (retry, notification)

### Phase 7: Polish & Ship (Week 9-10)
**Goal: Production-ready release**
- Auto-update (electron-updater + GitHub Releases)
- Auto-start on login (optional)
- First-run setup wizard (detect OpenClaw dir, check health)
- Error handling and offline states
- Performance optimization (lazy loading pages, virtual scrolling for logs)
- Cross-platform testing: macOS, Windows, Linux
- Package: .dmg, .exe (NSIS), .AppImage
- README, screenshots, release notes
- Publish v1.0.0 on GitHub

---

## 8. Key Technical Decisions

### Why Electron over Tauri?
- OCM's entire backend is Node.js — Electron includes Node.js, so migration is natural
- Tauri requires Rust for the backend, which means rewriting all server logic
- Electron's ecosystem for auto-update, packaging, and tray management is more mature
- The 150MB app size tradeoff is acceptable for a local developer tool

### Why React over keeping vanilla JS?
- OCM's #1 recurring bug category is template literal escaping (documented 4+ times in DEVLOG)
- At 5000+ lines, a single-file vanilla JS app becomes unmaintainable
- React components isolate concerns: each page is independent, testable
- TypeScript catches bugs at compile time
- Massive ecosystem for UI components, hooks, state management

### Why keep the HTTP API layer?
- OCM's API is well-tested and covers all needed operations
- Allows gradual migration: start with HTTP over IPC, replace with direct IPC later
- Keeps the door open for remote web access (serve HTTP for LAN users)
- Reduces initial migration risk

### Why dark theme only (initially)?
- OCM already has a mature dark theme
- ODO's target users are developers/power users who prefer dark
- Adding light theme doubles CSS work for no immediate user value
- Can add light theme in v1.1 if demanded

---

## 9. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Electron app size too large | Low — dev tool, not consumer app | Accept 150MB, optimize later with electron-builder asar |
| Remote WebSocket auth issues | Medium — token handling across machines | Provide SSH tunnel instructions as fallback |
| Cross-platform CLI differences | Medium — child_process behavior varies | Test on all 3 platforms early in Phase 4 |
| Gateway auto-management conflicts | Medium — user may run gateway separately | Detect existing gateway, offer to attach instead of restart |
| React migration takes longer than estimated | High — 256KB of legacy code | Phase 0-1 focus on new code, legacy migration in later phases |
| OCM users confused by new product name | Low | Clear migration guide, same GitHub repo or redirect |

---

## 10. Success Metrics for v1.0

1. **Double-click to dashboard in under 3 seconds** (cold start)
2. **All OCM features working** in the Electron wrapper
3. **Remote management** of at least one remote instance
4. **Backup + restore** verified on all 3 platforms
5. **Auto-update** working via GitHub Releases
6. **Zero template-literal escaping bugs** (the React migration goal)

---

## 11. Resolved Decisions

1. **Product name**: ODO (OpenClaw Dashboard Orchestrator) — confirmed
2. **GitHub repo**: new repo `odo`, separate from `ocm`
3. **OCM maintenance**: gradual sunset — keep OCM working but no new features; ODO is the future
4. **i18n**: English only. No Chinese support planned.
5. **Cron**: merged into Settings page (scheduled backup settings + auto-start toggle)
6. **App icon**: TBD — needs design

## 12. Open Questions

1. **App icon**: design needed — lobster/claw themed?
2. **Phase 0.5 (current)**: Electron shell wrapping existing OCM — ship as v0.1.0-alpha?

---

## Appendix: Feature Comparison (OCM → ODO)

| Feature | OCM (current) | ODO (planned) |
|---------|---------------|---------------|
| Launch method | `bash start.sh` → browser | Double-click app icon |
| Dashboard | Browser tab | Native window |
| Agent management | Full CRUD wizard | Read-focused console + inline edit |
| Stats | Basic charts | Enhanced: trends, predictions |
| CLI Terminal | In-browser | In-app dock panel |
| Log Viewer | Partial (ops menu) | Full dedicated page |
| Backup (local) | Snapshots in .openclaw dir | Versioned history + diff viewer |
| Backup (remote) | NAS SSH (complex) | Any SSH server (simplified) |
| Cron management | System crontab UI | Simplified scheduled backup |
| Remote management | None | WebSocket to remote Gateway |
| System tray | None | Full tray with status indicator |
| Gateway management | Manual restart button | Auto-start/stop/crash recovery |
| Auto-update | None | GitHub Releases + electron-updater |
| Auto-start | None | OS login item option |
| Multi-instance | Single local dir | Multiple local + remote instances |
| Code structure | Single file (256KB) | React components + TypeScript |
| Dependencies | Zero | Electron + React + build tools |
