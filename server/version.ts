// Paseo forbids runtime modules from importing package.json at the plugin root. The version test
// compares this value to package.json so a SemVer release cannot drift from the MCP handshake.
export const PLUGIN_VERSION = "0.4.1";
