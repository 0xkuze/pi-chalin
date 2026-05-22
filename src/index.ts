import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChalinAutoRouter } from "./autoroute.ts";
import { hideLegacyTopLevelChildSessions } from "./child-sessions.ts";
import { registerChalinCommands } from "./commands.ts";
import { registerChalinTools } from "./tools.ts";
import { setChalinStatus } from "./ui-status.ts";

const PI_CHALIN_CHILD_ENV = "PI_CHALIN_CHILD";
const PI_CHALIN_DISABLED_ENV = "PI_CHALIN_DISABLED";

export default function registerPiChalin(pi: ExtensionAPI): void {
  if (process.env[PI_CHALIN_CHILD_ENV] === "1" || process.env[PI_CHALIN_DISABLED_ENV] === "1") return;

  registerChalinCommands(pi);
  registerChalinTools(pi);
  registerChalinAutoRouter(pi);

  pi.on("session_start", (_event, ctx) => {
    void hideLegacyTopLevelChildSessions(ctx).then((result) => {
      if (ctx.hasUI && result.moved.length > 0) {
        ctx.ui.notify(`pi-chalin hid ${result.moved.length} legacy child session(s) from Pi resume.`, "info");
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`pi-chalin legacy child session cleanup failed: ${message}`);
    });
    if (!ctx.hasUI) return;
    setChalinStatus(ctx, { kind: "idle" });
  });
}

export { PI_CHALIN_CHILD_ENV, PI_CHALIN_DISABLED_ENV };
export { AgentCatalog, parseFrontmatter } from "./agents.ts";
export { ArtifactStore } from "./artifacts.ts";
export { DEFAULT_CONFIG, approvalDecision, loadEffectiveConfig, setAgentModelOverride, setAgentThinkingOverride, writeProjectConfig, writeUserConfig } from "./config.ts";
export { ChalinKernel } from "./kernel.ts";
export { MemoryStore, createMemoryCandidate } from "./memory.ts";
export { EngramMemoryStore, createConfiguredMemoryStore, resolveMemoryBackendStatus } from "./memory-provider.ts";
export { MockWorkerRunner, SdkWorkerRunner, parseAgentOutput } from "./runner.ts";
export { resolveChalinPaths } from "./paths.ts";
export type { AgentDefinition, AgentMemoryPolicy, AgentThinkingLevel, RouteDecision, RoutePlan, RunState, MemoryCandidate, MemoryRecord } from "./schemas.ts";
export type { MemoryProvider } from "./config.ts";
