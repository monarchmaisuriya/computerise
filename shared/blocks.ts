export type BuiltInBlock = { bundleId: string; name: string; level: "no-input" | "no-view"; removable: boolean };

export const PASEO_BUNDLE_ID = "sh.paseo.desktop";

// Shared by policy and settings so the list the user edits is exactly the list the server enforces.
export const BUILT_IN_BLOCKS: readonly BuiltInBlock[] = [
  { bundleId: PASEO_BUNDLE_ID, name: "Paseo", level: "no-input", removable: false },
  { bundleId: "com.apple.Terminal", name: "Terminal", level: "no-input", removable: true },
  { bundleId: "com.googlecode.iterm2", name: "iTerm2", level: "no-input", removable: true },
  { bundleId: "dev.warp.Warp-Stable", name: "Warp", level: "no-input", removable: true },
  { bundleId: "com.mitchellh.ghostty", name: "Ghostty", level: "no-input", removable: true },
  { bundleId: "com.apple.ScriptEditor2", name: "Script Editor", level: "no-input", removable: true },
  { bundleId: "com.apple.Automator", name: "Automator", level: "no-input", removable: true },
  { bundleId: "com.apple.shortcuts", name: "Shortcuts", level: "no-input", removable: true },
  { bundleId: "com.apple.dt.Xcode", name: "Xcode", level: "no-input", removable: true },
  { bundleId: "com.microsoft.VSCode", name: "Visual Studio Code", level: "no-input", removable: true },
  { bundleId: "com.todesktop.230313mzl4w4u92", name: "Cursor", level: "no-input", removable: true },
  { bundleId: "com.anthropic.claudefordesktop", name: "Claude", level: "no-input", removable: true },
  { bundleId: "com.apple.systempreferences", name: "System Settings", level: "no-input", removable: true },
  { bundleId: "com.apple.keychainaccess", name: "Keychain Access", level: "no-view", removable: true },
  { bundleId: "com.1password.1password", name: "1Password", level: "no-view", removable: true },
  { bundleId: "com.bitwarden.desktop", name: "Bitwarden", level: "no-view", removable: true },
];
