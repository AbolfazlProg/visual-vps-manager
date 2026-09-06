# Security

## Credential storage

- Passwords, private keys and key passphrases are encrypted with Electron
  `safeStorage` **before** touching disk:
  - Windows → DPAPI (bound to the user account)
  - macOS → Keychain
  - Linux → libsecret (GNOME Keyring) / KWallet
- Ciphertext lives in `vault.bin` inside the app's user-data directory.
- If the OS secure store is unavailable, saving secrets is refused
  (`SECURE_STORAGE_UNAVAILABLE`) — there is no silent plaintext fallback.
- "Forget credentials" deletes the vault entry; deleting a profile deletes
  profile + credentials + host-key pin.

## SSH security

- **Host-key pinning (TOFU):** the first connect shows the SHA256 fingerprint
  and requires explicit acceptance; the pin is stored per `host:port`.
- **Key change → hard warning:** a different fingerprint produces
  `EHOSTKEY` with a MITM-warning dialog; the app refuses to continue silently.
- Auth supports password and OpenSSH private keys (encrypted keys supported via
  passphrase). Keyboard-interactive is answered automatically for password
  auth (common on hardened servers). No agent forwarding, no X11 forwarding.

## Command execution

- UI can never emit shell text. Mutations are typed `FileOperation`s executed
  by `OperationService`; every dynamic value passes through `shq()`
  (POSIX single-quote escaping) via fixed command builders.
- Path validation: lexical normalization, `..` escape rejection, entry-name
  validation (no separators/NUL/control chars, ≤255 bytes).
- `rm -rf` is only reachable behind a confirmation dialog that shows exact
  paths + file count + total size; root `/` deletion is refused server-side.
- Move/copy refuses to place a directory inside itself.
- Service names, unit names, PIDs, signals, octal modes, owner/group names are
  all strictly validated before reaching a command.

## sudo

- The sudo password is requested explicitly in the UI ("Unlock sudo"),
  verified with `sudo -S -p '' -v`, and kept **in main-process memory only**.
- Privileged commands feed the password via stdin; it never appears in argv,
  command logs, activity log, or error details.
- "Forget" clears it; disconnect clears it.

## Data on the wire

- Everything runs inside the SSH encrypted channel (the app opens no other
  network ports). The renderer has no direct network access (CSP + sandbox).

## Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Malicious server compromises client | renderer sandboxed, no node in renderer, no remote content, strict CSP |
| Stolen laptop → credential theft | OS-key-store encryption (DPAPI/Keychain), no plaintext secrets |
| MITM / rogue server | host-key pinning + change warning |
| Malicious path input (`../`, NUL, control chars) | lexical path validation, name validation |
| Command injection via file names | single-quote escaping builders (unit-tested, integration-tested with hostile names) |
| Accidental destruction | trash + restore/undo, confirmations with size/count, no `/` deletion |
| Secret leakage via logs | activity log scrubs; sudo password kept out of all logs |

## Known limitations

- SFTP `setstat` chmod cannot set setuid/setgid/sticky bits reliably on all
  servers (protocol limitation); recursive/privileged chmod uses `chmod -R`.
- Host-key pinning is per app installation (not shared with `~/.ssh/known_hosts`).
- sudo timestamp relies on per-command stdin feeding (works with
  `Defaults:!requiretty` defaults; very unusual sudoers setups may need
  NOPASSWD for the specific commands).
- Credential vault is not portable across machines by design (DPAPI binding).
