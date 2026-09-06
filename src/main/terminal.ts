/**
 * Terminal service: real remote PTY via SSH `shell({ pty })`.
 * Data flows over IPC: main → renderer (output) and renderer → main (input).
 * Ctrl+C, resize, and exit codes behave like a real terminal because it IS one.
 */

import type { TerminalSize } from "../shared/protocol";
import type { SshSession, ShellHandle } from "./ssh";

export interface TerminalHandle {
  id: string;
  profileId: string;
  write(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
}

export class TerminalService {
  private terminals = new Map<string, TerminalHandle & { handle: ShellHandle | null }>();

  constructor(
    private readonly onOutput: (termId: string, data: string) => void,
    private readonly onExit: (termId: string, reason: string) => void
  ) {}

  async open(session: SshSession, profileId: string, size: TerminalSize): Promise<string> {
    const id = session.nextId("term");
    const entry: TerminalHandle & { handle: ShellHandle | null } = {
      id, profileId, handle: null,
      write: (data) => entry.handle?.write(data),
      resize: (size2) => entry.handle?.resize(size2),
      close: () => {
        entry.handle?.end();
        this.terminals.delete(id);
      }
    };
    this.terminals.set(id, entry);

    const handle = await session.openShell(size, {
      onData: (d) => this.onOutput(id, d),
      onClose: (reason) => {
        this.terminals.delete(id);
        this.onExit(id, reason);
      },
      onError: (msg) => this.onOutput(id, `\r\n[error] ${msg}\r\n`)
    });
    entry.handle = handle;
    return id;
  }

  write(termId: string, data: string): void {
    this.terminals.get(termId)?.write(data);
  }

  resize(termId: string, size: TerminalSize): void {
    this.terminals.get(termId)?.resize(size);
  }

  close(termId: string): void {
    this.terminals.get(termId)?.close();
  }

  closeAll(): void {
    for (const t of [...this.terminals.values()]) t.close();
  }
}
