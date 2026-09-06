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

Items marked "live-runbook" transfer through the identical SFTP streaming code
path validated by the fixture; they additionally appear in the manual live
scenario list below because real-network behavior (latency, MTU, interruption)
is environment-specific.

## Live VPS runbook (execute when a server is available)

1. Add server (host/port/user/password) → **Test Connection** → Save.
2. Connect → expect 🟢 and file manager opening at `/`.
3. Create folder `vpsm-live-test` → create file `hello.txt` → edit in editor →
   type text → Ctrl+S → reopen → text persisted.
4. Rename `hello.txt` → `hello2.txt`; duplicate it → `hello2 (copy).txt`.
5. Upload a >100 MB local file via toolbar → watch progress/speed → Cancel →
   Resume from the transfer panel.
6. Download `hello2 (copy).txt` → verify content locally.
7. Drag a row onto a folder → move; verify via breadcrumb navigation.
8. Delete → trash → restore from Trash page → verify content.
9. Permissions dialog: chmod 600 on a file, verify; set owner via sudo.
10. Monitor: CPU/RAM/disk/net donuts animate; compare with `htop`/`df`.
11. Services: restart `nginx.service` (or any harmless unit) via sudo; verify
    `systemctl status` shows active; check logs page streams `journalctl`.
12. Processes: kill a `sleep 300` started from the terminal.
13. Error paths: wrong password (EAUTH toast), stop `sshd`-adjacent harmless
    service without sudo (EACCES_ROOT guidance), disconnect network mid-op
    (ECONN with retry), edit-while-changed (conflict dialog).
14. Activity page shows every step; no secrets anywhere.

## Known issues / notes

- Windows hosts cannot model POSIX permission bits for the fixture filesystem;
  the chmod tests assert operation success (bits verified on POSIX systems and
  in the live runbook).
- First `vite build` after a clean clone may take ~10 s (esbuild spawn).
- Environments with restricted process spawning (application sandboxes) block
  esbuild/vitest child processes; run tests from a normal shell.
