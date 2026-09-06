# Architecture

## Overview

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React 18 + TS, sandboxed, contextIsolation)         │
│  pages/ components/ store (zustand)                            │
└──────────────┬────────────────────────────────────────────────┘
               │ window.vpsm — typed IPC (contextBridge whitelist)
┌──────────────▼────────────────────────────────────────────────┐
│ Electron Main                                                  │
│  main.ts (IPC registration)                                    │
│   ├─ SessionRegistry ── SshSession (ssh2 client)               │
│   │      ├─ CredentialVault (safeStorage → OS key store)       │
│   │      └─ HostKeyStore (TOFU pinning, SHA256)                │
│   ├─ OperationService (Command Translation Layer)              │
│   │      validation → SFTP API or escaped shell → result+undo  │
│   ├─ TransferManager (streaming, progress, cancel, resume)     │
│   ├─ MetricsService / ServicesManager / ProcessManager         │
│   ├─ LogService (journalctl -f / tail -F streams)              │
│   ├─ TerminalService (SSH PTY channels)                        │
│   └─ ProfileStore / ActivityLog (JSON, atomic writes)          │
└──────────────┬────────────────────────────────────────────────┘
               │ SSH (port 22) — SFTP subsystem + exec + PTY
┌──────────────▼────────────────────────────────────────────────┐
│ Remote Linux VPS                                               │
└───────────────────────────────────────────────────────────────┘
```

## Command Translation Layer

The renderer never builds commands. Every mutation is expressed as a
`FileOperation` (discriminated union in `src/shared/protocol.ts`) and executed
by `OperationService`:

```
UI Action → Operation Model → Validation (paths.ts) → Transport choice
   → SFTP API (preferred) or escaped shell (shell.ts) → Server
   → OperationResult { message, affected, undo? } → UI feedback + Activity log
```

Transport choice per operation:

| Operation | Transport | Notes |
|---|---|---|
| list/stat/read/write | SFTP | streaming, no full-file buffering on write paths > editor cap |
| rename | SFTP rename | falls back to escaped `mv --` on `EXDEV` |
| mkdir | SFTP mkdir | |
| create file | SFTP open `wx` | exclusive create → EEXIST surfaced to UI |
| chmod (non-recursive) | SFTP setstat | sudo `chmod` escalation when EPERM + sudo unlocked |
| chmod -R / chown | escaped `chmod -R`/`chown` via sudo | |
| copy / duplicate | escaped `cp -r --` | |
| delete → trash | SFTP rename into `~/.vpsmgr-trash` + meta JSON | undo = restore op |
| delete permanent | escaped `rm -rf --` | requires size/count confirmation from UI |
| metrics | one batched exec (`/proc` + `df`) | pure parsers in shared/ |
| services | exec `systemctl` | SysV fallback; sudo for start/stop/restart |
| processes | exec `ps` + `kill` | sudo escalation for foreign processes |
| logs | stream exec `journalctl -f` / `tail -F` | line-buffered, stoppable |
| terminal | SSH `shell({ pty })` | raw byte pipe to xterm.js |

## Shell safety model

- `shq()` (single-quote escaping) is the only path from a dynamic value into a
  shell string; command builders (`cmdMv`, `cmdCpRecursive`, `cmdRmRecursive`,
  `cmdChmod`, `cmdChown`, …) all route through it.
- `validateEntryName()` rejects separators, `.`/`..`, NUL and control chars.
- `assertSafeRemotePath()` lexically normalizes absolute POSIX paths; `..`
  cannot survive, traversal above `/` is rejected.
- Sudo: `sudo -S -p '' -v` validates once (password via stdin, memory-only);
  privileged commands run as `sudo -S -p '' <cmd>` with the same stdin feed.
  The password never appears in argv, logs, or the activity log.

## Error taxonomy

All cross-process errors are `SerializedVpsmError` (`src/shared/errors.ts`) with
stable codes (`EPERM`, `ENOENT`, `EEXIST`, `ENOSPC`, `EHOSTKEY`, `EAUTH`,
`ETIMEDOUT`, `EACCES_ROOT`, …). `classifyFsError` maps Node/ssh2 errors
(including numeric SFTP status codes) onto the taxonomy; the renderer maps
codes to human copy with remediation hints.

## Host-key verification

`hostVerifier` computes the SHA256 fingerprint and compares it with the pin in
`hostkeys.json`. Unknown key → first connect fails with `EHOSTKEY` (fingerprint
surfaced); the UI shows a verification dialog; on explicit accept the pin is
stored and the next handshake proceeds. A **changed** key produces a distinct
warning (possible MITM / reinstall).

## Persistence layout (`app.getPath("userData")`)

| File | Content |
|---|---|
| `profiles.json` | non-secret server profiles |
| `vault.bin` | OS-encrypted credentials (safeStorage blobs) |
| `hostkeys.json` | pinned host keys (TOFU) |
| `activity.jsonl` | capped activity log (500 entries) |

All writes are atomic (tmp + rename). No secret is ever written unencrypted.

## Concurrency & performance

- max 2 concurrent transfers per server (queue), 64 KiB streaming chunks
- directory listing is per-directory (never recursive); sidebar tree is lazy
- metrics use one batched command per sample; parsers are pure functions
- exec enforces per-command timeouts; terminal/log channels are cancellable

## Renderer security

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict
CSP (no remote content), IPC surface limited to the whitelisted `vpsm` API.
