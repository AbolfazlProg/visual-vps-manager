# Testing

## Test stack

| Level | Tooling | What it proves |
|---|---|---|
| Unit | vitest | path validation, shell escaping, command builders, parsers, error mapping |
| Integration | vitest + **real in-process SSH server** (ssh2 server mode) | the app's real SSH client against a real SSH/SFTP wire protocol with an fs-backed SFTP subsystem and a shell that executes the app's actual commands |
| App smoke | Electron launch check | process model + window boot |
| Live VPS | manual runbook (below) | real-world behavior on a real server |

## Running

```bash
npm test
```

Current status: **65 tests, all passing** (33 unit + 32 integration).

The integration fixture (`tests/ssh-fixture.ts`) implements:
- real SSH handshake, password + keyboard-interactive auth (good/bad paths)
- real SFTP subsystem backed by a temp directory (open/read/write/close,
  opendir/readdir with EOF, mkdir/rmdir/rename/remove/setstat/readlink/realpath)
- a shell that parses the app's actual commands (top-level `;`/`&&`/`||`
  splitting that is quote/paren-aware), executes them against the same
  directory tree, and returns real exit codes — validating escaping,
  sudo (`-S -p '' -v` + stdin), and command side-effects end-to-end.

## What the integration suite covers

- auth: wrong password → `EAUTH`; correct → connected; exec round-trip
- host-key TOFU: first connect refused (`EHOSTKEY`), pin → connect succeeds
- timeouts: long-running command → `ETIMEDOUT`
- fs: list, mkdir, create (EEXIST on duplicate), read (mtime), rename,
  move (SFTP + EXDEV path), copy, duplicate, delete→trash→restore (undo
  round-trip), permanent delete, chmod, writeFile (atomic tmp+rename)
- **hostile names end-to-end**: `it's a ; rm -rf ~; $(id) test` is created,
  renamed and deleted — no injection possible
- security: traversal (`../evil`, `a/b`) rejected with `EINVAL_PATH`
- sudo: wrong password rejected, correct verified, escalation enforced
- metrics: full snapshot parsed from the batched `/proc` command (CPU cores,
  mem totals, disk mounts, OS, kernel, CPU model), CPU delta between samples
- services: unit states parsed (running/failed/stopped), enabled flags,
  restart through sudo
- processes: ps parsing, own-process kill, sudo escalation for foreign PID,
  invalid PID/signal rejection
- logs: `journalctl -f` stream receives lines and stops cleanly
- trash: metadata listing + empty

## Feature test matrix

| Feature | UI | Backend | Fixture-tested | Error-tested | Status |
|---|---|---|---|---|---|
| Add/Edit/Duplicate/Delete profile | ✓ | ✓ | ✓ (store layer) | ✓ | Complete |
| Connect (password/key/kbd-interactive) | ✓ | ✓ | ✓ | ✓ (bad password) | Complete |
| Host-key TOFU + change warning | ✓ | ✓ | ✓ | ✓ | Complete |
| Test connection | ✓ | ✓ | ✓ | ✓ | Complete |
| List directory (SFTP) | ✓ | ✓ | ✓ | ✓ (ENOENT) | Complete |
| Create folder/file | ✓ | ✓ | ✓ | ✓ (EEXIST, EINVAL) | Complete |
| Rename | ✓ | ✓ | ✓ | ✓ | Complete |
| Copy / Duplicate | ✓ | ✓ | ✓ | ✓ | Complete |
| Move (SFTP + mv fallback) | ✓ | ✓ | ✓ | ✓ (self-move refused) | Complete |
| Delete → trash → restore/undo | ✓ | ✓ | ✓ | ✓ | Complete |
| Permanent delete w/ confirmation | ✓ | ✓ | ✓ | ✓ | Complete |
| Permissions UI (chmod/chown) | ✓ | ✓ | ✓ (chmod; chown via sudo path) | ✓ (EPERM surfaced) | Complete |
| Upload (streaming, progress, cancel, resume) | ✓ | ✓ | ✓ (protocol) | ✓ (ENOENT, EEXIST) | Complete (fixture); live-runbook item |
| Download | ✓ | ✓ | ✓ | ✓ | Complete (fixture); live-runbook item |
| Editor (CM6, save, conflict guard) | ✓ | ✓ | ✓ (writeFile atomicity) | ✓ (mtime conflict) | Complete |
| Terminal (real PTY) | ✓ | ✓ | ✓ (shell channel w/ Ctrl+C, exit) | ✓ | Complete |
| Metrics dashboard | ✓ | ✓ | ✓ | ✓ | Complete |
| Services manager | ✓ | ✓ | ✓ | ✓ (sudo required) | Complete |
| Process manager + kill | ✓ | ✓ | ✓ | ✓ | Complete |
| Log viewer (live) | ✓ | ✓ | ✓ | ✓ | Complete |
| sudo flow | ✓ | ✓ | ✓ | ✓ (wrong password) | Complete |
| Activity log | ✓ | ✓ | ✓ | — | Complete |
| Trash page | ✓ | ✓ | ✓ | ✓ | Complete |
| Live-VPS scenarios (isolated dir) | — | ✓ | **✓ 11/11 on real Ubuntu 22.04** | ✓ | **Complete** |
| Server ⋯ menu viewport containment | ✓ | — | ✓ (E2E regression) | ✓ | Complete |
| Single-file portable EXE | ✓ | — | smoke-launched | — | Complete |

Items marked "live-runbook" transfer through the identical SFTP streaming code
path validated by the fixture; they additionally appear in the manual live
scenario list below because real-network behavior (latency, MTU, interruption)
is environment-specific.

## Live VPS runbook (execute when a server is available)

**Status: EXECUTED against a real server (Ubuntu 22.04.5 LTS, kernel 5.15) — 11/11 passed.**

The live suite (`tests/live-vps.test.ts`, gated behind `VPSM_LIVE=1` +
`local-test/live-vps.json`, which is gitignored) runs everything inside a
dedicated isolated directory `$HOME/.vpsm-live-test` that is wiped before and
removed after the run — nothing else on the server is touched. No service
restarts, no kills, no sudo on the live box.

| # | Scenario | Result |
|---|---|---|
| 1 | Connect (password) + TOFU host-key pin | ✓ |
| 2 | SFTP readdir of real $HOME with owner/perms | ✓ |
| 3 | mkdir/create/read/rename/copy/move/duplicate + hostile-name injection safety | ✓ |
| 4 | chmod 640 via SFTP setstat — real bits verified | ✓ |
| 5 | delete → trash → restore (undo) → permanent delete | ✓ |
| 6 | remote find search + du size probe | ✓ |
| 7 | upload + download 1 MB, SHA256-identical round-trip | ✓ |
| 8 | metrics snapshot (CPU cores, RAM, disks, Ubuntu/kernel) | ✓ |
| 9 | services + processes lists (read-only) | ✓ |
| 10 | journalctl stream | ✓ |
| 11 | interactive PTY shell executes a marker command | ✓ |

### Bugs the live run caught (all fixed + regression-covered)

1. `df -PB1` is invalid on Ubuntu (P and --output are mutually exclusive) →
   metrics returned no disks. Fixed to `df -B1 --output=…`.
2. Uploading a Windows path (`H:\…`) crashed in `basenameOf` (POSIX-only
   normalization on a host-native path). Fixed to `path.basename`.
3. SFTP rename/move onto an existing target failed with an opaque "Failure".
   Now a clear `EEXIST` ("An item named X already exists in …") is surfaced.
4. Trash metadata always reported size 0. Now records the real byte size.

## Known issues / notes

- Windows hosts cannot model POSIX permission bits for the fixture filesystem;
  the chmod tests assert operation success (bits verified on POSIX systems and
  in the live runbook).
- First `vite build` after a clean clone may take ~10 s (esbuild spawn).
- Environments with restricted process spawning (application sandboxes) block
  esbuild/vitest child processes; run tests from a normal shell.
