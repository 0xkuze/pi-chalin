import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ChalinPathsOptions {
  cwd: string;
  userRoot?: string;
  packageRoot?: string;
}

export interface ChalinPaths {
  cwd: string;
  packageRoot: string;
  builtInAgentsDir: string;
  projectRoot: string;
  projectConfigPath: string;
  projectAgentsDir: string;
  userRoot: string;
  userConfigPath: string;
  userAgentsDir: string;
}

export function packageRootFromImportMeta(importMetaUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

export function resolveChalinPaths(options: ChalinPathsOptions): ChalinPaths {
  const cwd = path.resolve(options.cwd);
  const packageRoot = options.packageRoot ? path.resolve(options.packageRoot) : packageRootFromImportMeta();
  const projectRoot = cwd;
  const userRoot = options.userRoot ? path.resolve(options.userRoot) : path.join(os.homedir(), ".pi", "chalin");

  return {
    cwd,
    packageRoot,
    builtInAgentsDir: path.join(packageRoot, "agents"),
    projectRoot,
    projectConfigPath: path.join(projectRoot, ".pi-chalin", "config.json"),
    projectAgentsDir: path.join(projectRoot, ".pi-chalin", "agents"),
    userRoot,
    userConfigPath: path.join(userRoot, "config.json"),
    userAgentsDir: path.join(userRoot, "agents"),
  };
}

export function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}
