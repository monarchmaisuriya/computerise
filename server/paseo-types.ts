import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The plugin SDK uses this type in its contexts but does not export it by name. Deriving it here
// keeps every import inside the SDK: Paseo rejects type imports from @getpaseo/client or
// @getpaseo/protocol, which a Git install without dev packages does not contain (from memorise).
export type PaseoApi = PluginHandlerContext["paseo"];
