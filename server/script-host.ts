import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { hostProgram, SCRIPTS, type ScriptName } from "./engine-scripts";
import type { RunFile } from "./engine";

// How the engine runs its fixed JXA programs. The output is the program's JSON text.
export interface ScriptRunner {
  run(name: ScriptName, input: object, timeoutMs: number): Promise<string>;
  // Fails the running request and anything queued behind it.
  interrupt?(): void;
}

// One new osascript per call. The input is always a JSON object, so it starts with "{" and
// osascript never reads it as an option.
export function perCallScripts(run: RunFile): ScriptRunner {
  return { run: (name, input, timeoutMs) => run("osascript", ["-l", "JavaScript", "-e", SCRIPTS[name], JSON.stringify(input)], timeoutMs) };
}

const STDERR_KEPT = 2_000;

// The host decodes each pipe read on its own, so a character split across two reads would be lost.
// Escaping everything outside ASCII keeps every byte a whole character.
function asciiJson(value: object): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

type Request = { id: number; name: string; input: object; timeoutMs: number; resolve(out: string): void; reject(error: Error): void };

// One long-lived osascript running hostProgram. It runs one request at a time, so requests are sent
// one at a time and each deadline starts when its request is sent: time spent waiting behind a long
// request (typing 2,000 characters) never counts against a short one. A request that misses its
// deadline, or a host that exits, fails the running and every queued request and drops the process;
// the next call starts a new one.
export class ScriptHost<Name extends string> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";
  private readonly queue: Request[] = [];
  private running: { request: Request; timer: NodeJS.Timeout } | null = null;
  private nextId = 0;
  private closed = false;
  private readonly program: string;

  constructor(private readonly scripts: Readonly<Record<Name, string>>) {
    this.program = hostProgram(scripts);
  }

  run(name: Name, input: object, timeoutMs: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("The script host is closed"));
    if (!Object.hasOwn(this.scripts, name)) return Promise.reject(new Error(`Unknown script ${JSON.stringify(name)}`));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, name, input, timeoutMs, resolve, reject });
      this.sendNext();
    });
  }

  close(): void {
    this.closed = true;
    this.drop(new Error("The script host is closed"));
  }

  interrupt(): void {
    this.drop(new Error("Interrupted because computer use was stopped"));
  }

  private sendNext(): void {
    if (this.running || this.queue.length === 0) return;
    const request = this.queue.shift() as Request;
    const child = this.current();
    const timer = setTimeout(() => this.drop(new Error(`The ${request.name} script did not answer within ${request.timeoutMs} ms; the script host was restarted`)), request.timeoutMs);
    this.running = { request, timer };
    child.stdin.write(`${asciiJson({ id: request.id, name: request.name, input: request.input })}\n`);
  }

  private current(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn("osascript", ["-l", "JavaScript", "-e", this.program], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stderr = "";
    const fromThisHost = (handle: () => void) => () => {
      if (this.child === child) handle();
    };
    child.stderr.setEncoding("utf8").on("data", (text: string) =>
      fromThisHost(() => {
        this.stderr = (this.stderr + text).slice(-STDERR_KEPT);
      })(),
    );
    createInterface({ input: child.stdout }).on("line", (line) => fromThisHost(() => this.answer(line))());
    child.on("error", (error) => fromThisHost(() => this.drop(new Error(`The script host could not run: ${error.message}`)))());
    child.on("exit", (code, signal) => fromThisHost(() => this.drop(new Error(`The script host exited (${signal ?? `code ${code}`})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`)))());
    // A write after the host died surfaces as the exit above, not as an unhandled stream error.
    child.stdin.on("error", () => undefined);
    return child;
  }

  private answer(line: string): void {
    let reply: { id?: unknown; out?: unknown; error?: unknown };
    try {
      reply = JSON.parse(line);
    } catch {
      this.drop(new Error(`The script host printed ${JSON.stringify(line.slice(0, 200))}, not a JSON reply`));
      return;
    }
    const running = this.running;
    if (!running || reply.id !== running.request.id) {
      this.drop(new Error(`The script host answered request ${JSON.stringify(reply.id)}, which is not the one running`));
      return;
    }
    this.running = null;
    clearTimeout(running.timer);
    const { request } = running;
    if (typeof reply.error === "string") request.reject(new Error(reply.error));
    else if (typeof reply.out === "string") request.resolve(reply.out);
    else request.reject(new Error(`The ${request.name} script returned no text`));
    this.sendNext();
  }

  // Fails the running request and every queued one, so nothing runs after the failure was reported.
  private drop(error: Error): void {
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
    if (this.running) {
      clearTimeout(this.running.timer);
      this.running.request.reject(error);
      this.running = null;
    }
    for (const request of this.queue.splice(0)) request.reject(error);
  }
}
