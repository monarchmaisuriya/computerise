import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Copied from memorise. The plugin API offers no data folder, and import.meta.url is undefined in
// plugin code, so PASEO_HOME is resolved the way the daemon does. The plugin process is started
// from a script inside @getpaseo/server, which makes that package resolvable.
export async function resolveDataRoot(): Promise<string> {
  const requireFromDaemon = createRequire(process.argv[1]);
  const daemonControl: unknown = await import(pathToFileURL(requireFromDaemon.resolve("@getpaseo/server/daemon-control")).href);
  const resolveHome: unknown = Reflect.get(Object(daemonControl), "resolvePaseoHome");
  if (typeof resolveHome !== "function") throw new Error("@getpaseo/server/daemon-control has no resolvePaseoHome; this Paseo version is not supported");
  const home: unknown = resolveHome();
  if (typeof home !== "string" || home === "") throw new Error("Paseo returned no home directory");
  return join(home, "plugin-data", "computerise");
}
