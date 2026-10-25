import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// For type, only the character count is recorded, never the text: it may be a password.
export type AuditEntry = { agentId: string | null; tool: string; target: string | null; outcome: string; chars?: number };

export class AuditLog {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  record(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
    const write = this.writes.then(() => this.append(line));
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const size = await stat(this.path).then(
      (info) => info.size,
      (error: unknown) => {
        if (Reflect.get(Object(error), "code") === "ENOENT") return 0;
        throw error;
      },
    );
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await rename(this.path, `${this.path}.1`);
    await appendFile(this.path, line, { mode: 0o600 });
  }
}
