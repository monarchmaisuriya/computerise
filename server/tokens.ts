import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const SECRET_BYTES = 32;

const tokenScopeSchema = z.object({ seat: z.string().min(1) });
export type TokenScope = z.infer<typeof tokenScopeSchema>;

// Copied from memorise's mcp-auth.ts. Paseo saves injected MCP entries with the agent and reuses
// them on resume, so a token stays valid across restarts: it carries the seat, signed with a secret
// kept on disk. The seat resolves to an agent through seats.json.
export class TokenAuthority {
  constructor(private readonly secret: Buffer) {
    if (secret.length !== SECRET_BYTES) throw new Error(`Expected a ${SECRET_BYTES}-byte token secret, got ${secret.length} bytes`);
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }

  mint(scope: TokenScope): string {
    const payload = Buffer.from(JSON.stringify(tokenScopeSchema.parse(scope))).toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }

  verify(authorization: string | undefined): TokenScope | null {
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!match) return null;
    const expected = this.sign(match[1]);
    const given = Buffer.from(match[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = tokenScopeSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  }
}

// Created once with mode 0600. Deleting the file invalidates every token already handed out.
export async function loadTokenSecret(root: string): Promise<Buffer> {
  const path = join(root, "secret");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(SECRET_BYTES), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
  }
  return readFile(path);
}
