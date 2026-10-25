import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "./version";

describe("plugin version", () => {
  it("uses package.json as the SemVer source advertised by the MCP server", () => {
    expect(packageJson.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
    expect(PLUGIN_VERSION).toBe(packageJson.version);
  });
});
