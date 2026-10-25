import { randomBytes } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
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
});
