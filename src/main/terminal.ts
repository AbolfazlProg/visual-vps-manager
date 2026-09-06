/**
 * Terminal service: real remote PTY via SSH `shell({ pty })`.
 * Data flows over IPC: main → renderer (output) and renderer → main (input).
 * Ctrl+C, resize, and exit codes behave like a real terminal because it IS one.
 */

import type { ClientChannel } from "ssh2";
import type { TerminalSize } from "../shared/protocol";
import type { SshSession } from "./ssh";

export interface TerminalHandle {
  id: string;
  profileId: string;
  write(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
}

export class TerminalService {
  private terminals = new Map<string, TerminalHandle & { channel: ClientChannel | null }>();

  constructor(
    private readonly onOutput: (termId: string, data: string) => void,
    private readonly onExit: (termId: string, reason: string) => void
  ) {}

  open(session: SshSession, profileId: string, size: TerminalSize): string {
    const id = session.nextId("term");
    const entry: TerminalHandle & { channel: ClientChannel | null } = {
      id, profileId, channel: null,
      write: (data) => {
        try { entry.channel?.write(data); } catch { /* noop */ }
      },
      resize: (size2) => {
        try { entry.channel?.setWindow(size2.rows, size2.cols, 0, 0); } catch { /* noop */ }
      },
      close: () => {
        try { entry.channel?.end(); } catch { /* noop */ }
        this.terminals.delete(id);
      }
    };
    this.terminals.set(id, entry);

    session.openShell(size, {
      onData: (d) => this.onOutput(id, d),
      onClose: (reason) => {
        this.terminals.delete(id);
        this.onExit(id, reason);
      },
      onError: (msg) => this.onOutput(id, `\r\n[error] ${msg}\r\n`)
    });
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
