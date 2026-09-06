# Visual VPS Manager

A professional, real-operations desktop application for managing **Linux VPS servers over SSH/SFTP** — with a full remote file manager, code editor, real terminal, live resource monitoring, service/process/log management and OS-encrypted credential storage.

> **No mock features.** Every button is wired to a real SSH/SFTP operation that is covered by automated tests running against a real in-process SSH server (real wire protocol, real SFTP subsystem).

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue) ![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript-3178c6)

## Features

### Connection Manager
- Add / Edit / Duplicate / Delete server profiles
- Password **and** SSH private-key auth (with passphrase support), keyboard-interactive fallback
- Test Connection, per-server connection state (🟢 connected · 🟡 connecting · 🔴 error · ⚠ host-key)
- Last-connected timestamps, independent state per server

### Security
- **Credentials encrypted with the OS secure store** — Electron `safeStorage` → Windows DPAPI / macOS Keychain / Linux libsecret. Plaintext secrets are never written to disk.
- **SSH host-key pinning (TOFU)** with SHA256 fingerprints; explicit warning dialog on key change
- Strict-escaping command layer — user input can never inject shell commands
- sudo password kept **in memory only** (per session), fed via stdin — never in argv or logs

### Remote File Manager
- Real SFTP listing with permissions, owner/group (uid/gid name resolution), sizes, mtimes
- Symlinks (with target + broken-link detection), hidden files toggle
- Breadcrumb navigation, back/forward, up, home, refresh, sorting, filtering
- **Remote-aware search** (`find` with depth limit — never scans the whole disk)
- Lazy-loading sidebar directory tree
- Context menu for files/folders (open, rename, copy/cut/paste, duplicate, download, permissions, delete…)
- Drag & drop: OS files in → upload; rows onto folders → remote move
- Batch operations: multi-select copy/move/delete/download

### File Operations (all real)
Create file/folder · rename · copy · move (SFTP rename with cross-device `mv` fallback) · duplicate (auto `(copy)` suffix) · **safe delete → server-side trash** (`~/.vpsmgr-trash` with metadata + one-click **Undo/Restore**) · permanent delete (with byte/file-count confirmation dialog) · chmod via SFTP setstat (recursive `chmod -R` with sudo escalation) · chown via sudo

### Transfers
Streaming upload/download (64 KiB chunks — GB files never enter RAM), live progress + speed + ETA, cancel, and **resume from offset** for interrupted transfers.

### Code Editor
CodeMirror 6: syntax highlighting for JS/TS/Python/PHP/HTML/CSS/JSON/YAML/XML/Bash/SQL/Markdown, search & replace, auto-indent, bracket matching, save via atomic SFTP write (temp file + rename + permission preservation), server-side mtime conflict detection, unsaved-changes guard, Ctrl+S.

### Terminal
Real remote **PTY** via SSH (`shell({ pty })`) + xterm.js: interactive programs, Ctrl+C, resize (window resize → `setWindow`), multiple tabs, copy/paste, exit detection.

### Monitoring
CPU (delta-based, per-load), RAM (used/available/cached/swap), disks (`df`), network rates (Δ/proc/net/dev), uptime/OS/kernel — donut charts + sparkline history, refreshed every 3 s.

### Services / Processes / Logs
systemd (with SysV fallback) list + start/stop/restart via sudo; `ps` process list with kill (TERM/KILL, sudo escalation); live log streaming (`journalctl -f` / `tail -F`) with filter, pause, clear, download.

### Activity Log
Every file/service/process/session/security action is recorded locally (secrets never logged).

## Development

```bash
npm install          # (sandboxed environments: see TESTING.md for cache flags)
npm run build        # tsc (main+preload) + vite (renderer)
npm start            # launch the built app
npm test             # unit + integration tests (65 tests)
npm run typecheck    # strict TS on all layers
```

Dev with renderer HMR (optional):
```bash
node_modules\.bin\vite.cmd            # terminal 1 (dev server on :5183)
set VITE_DEV_SERVER_URL=http://localhost:5183 && node_modules\.bin\electron.cmd .   # terminal 2
```

## Building an installer

```bash
npm run dist         # electron-builder → NSIS installer (release/)
```

## Test VPS setup (for live testing)

See `TESTING.md` § "Live VPS runbook" for the full scripted scenario list, and `SECURITY.md` for the threat model.

## Project layout

```
src/shared/     contract: paths, shell escaping, errors, parsers, protocol (main ⇄ renderer)
src/main/       Electron main: SSH/SFTP sessions, vault, host keys, operations, transfers,
                metrics, services, processes, logs, terminal, IPC registration
src/preload/    contextBridge API (whitelisted channels only)
src/renderer/   React UI (pages, components, store)
tests/          in-process real SSH/SFTP server fixture + integration tests
```

## Status

See `TESTING.md` for the feature test matrix. Core features are implemented and covered by 65 automated tests (unit + real-protocol integration). Live-VPS scenario runbook included.
