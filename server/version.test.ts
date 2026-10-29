import { readFileSync } from "node:fs";
import packageJson from "../package.json";
import packageLock from "../package-lock.json";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "./version";

describe("plugin version", () => {
  it("uses package.json as the SemVer source advertised by the MCP server", () => {
    expect(packageJson.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
    expect(PLUGIN_VERSION).toBe(packageJson.version);
  });

  it("names the same release in the lockfile and the README", () => {
    expect([packageLock.version, packageLock.packages[""].version]).toEqual([packageJson.version, packageJson.version]);
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(`Current release: **v${packageJson.version}**`);
  });
});
