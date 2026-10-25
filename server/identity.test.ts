import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTokenSecret, TokenAuthority } from "./tokens";
import { Seats } from "./seats";
import { tempDir } from "./test-temp-dir";

describe("bearer tokens", () => {
  it("round-trips a seat and refuses forged, malformed, and missing tokens", () => {
    const tokens = new TokenAuthority(randomBytes(32));
    const token = tokens.mint({ seat: "seat-1" });
    expect(tokens.verify(`Bearer ${token}`)).toEqual({ seat: "seat-1" });
    expect(new TokenAuthority(randomBytes(32)).verify(`Bearer ${token}`)).toBeNull();
    expect(tokens.verify(`Bearer ${token}x`)).toBeNull();
    expect(tokens.verify("Bearer nope")).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
  });

  it("keeps the secret in a file only the user can read, and reuses it", async () => {
    const root = tempDir("computerise-secret-");
    const first = await loadTokenSecret(root);
    expect(first).toHaveLength(32);
    expect((await stat(join(root, "secret"))).mode & 0o777).toBe(0o600);
    expect(await loadTokenSecret(root)).toEqual(first);
  });

  it("repairs permissions on an existing secret and data directory", async () => {
    const root = tempDir("computerise-secret-mode-");
    const secret = join(root, "secret");
    await writeFile(secret, randomBytes(32), { mode: 0o644 });
    await chmod(root, 0o755);

    await loadTokenSecret(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
  });
});

describe("seats", () => {
  it("binds a seat to one agent, keeps it across reopening, and refuses rebinding it to another agent", async () => {
    const path = join(tempDir("computerise-seats-"), "seats.json");
    const seats = await Seats.open(path);
    const seat = seats.mint();
    expect(seat).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(seats.mint()).not.toBe(seat);
    expect(seats.agentFor(seat)).toBeNull();
    await seats.bind(seat, "agent-x");
    await seats.bind(seat, "agent-x");
    await expect(seats.bind(seat, "agent-y")).rejects.toThrow(`Seat ${seat} already belongs to agent agent-x`);
    expect((await Seats.open(path)).agentFor(seat)).toBe("agent-x");
  });

  it("starts with no bindings when the file cannot be read, so no token resolves", async () => {
    const path = join(tempDir("computerise-seats-"), "seats.json");
    await writeFile(path, "[]");
    const seats = await Seats.open(path);
    expect(seats.problem).toMatch(/seats.json could not be read/);
    expect(seats.agentFor("anything")).toBeNull();
  });

  it("does not bind a seat in memory when persisting the binding fails", async () => {
    const root = tempDir("computerise-seats-fail-");
    const path = join(root, "seats.json");
    const seats = await Seats.open(path);
    const seat = seats.mint();
    await mkdir(path);

    await expect(seats.bind(seat, "agent-x")).rejects.toThrow();
    expect(seats.agentFor(seat)).toBeNull();
  });

  it("revokes every seat for an archived agent", async () => {
    const path = join(tempDir("computerise-seats-revoke-"), "seats.json");
    const seats = await Seats.open(path);
    const first = seats.mint();
    const second = seats.mint();
    await seats.bind(first, "agent-x");
    await seats.bind(second, "agent-x");
    await seats.revokeAgent("agent-x");
    expect(seats.agentFor(first)).toBeNull();
    expect(seats.agentFor(second)).toBeNull();
    expect((await Seats.open(path)).agentFor(first)).toBeNull();
  });

  it("revokes a seat in memory even when persisting revocation fails", async () => {
    const root = tempDir("computerise-seats-revoke-fail-");
    const path = join(root, "seats.json");
    const seats = await Seats.open(path);
    const seat = seats.mint();
    await seats.bind(seat, "agent-x");
    await rm(path);
    await mkdir(path);

    await expect(seats.revokeAgent("agent-x")).rejects.toThrow();
    expect(seats.agentFor(seat)).toBeNull();
  });
});
