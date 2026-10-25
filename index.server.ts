import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveDataRoot } from "./server/paseo-home";
import { contributeComputer } from "./server/plugin";

export default function contribute(server: PluginServerContext) {
  return contributeComputer(server, { resolveRoot: resolveDataRoot });
}
