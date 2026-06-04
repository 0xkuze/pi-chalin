import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { registerChalinAutoRouter } from "./routing/autoroute.ts";
import { registerChalinCommands } from "./commands/commands.ts";
import { resetRuntimeState } from "./runtime/state.ts";
import { registerBackgroundJobCompletionNotifier } from "./runtime/background-jobs.ts";
import { registerChalinTools } from "./tools/tools.ts";
import { setChalinStatus } from "./ui/ui-status.ts";

const PI_CHALIN_CHILD_ENV = "PI_CHALIN_CHILD";
const PI_CHALIN_DISABLED_ENV = "PI_CHALIN_DISABLED";

export default function registerPiChalin(pi: ExtensionAPI): void {
  Effect.runSync(Effect.sync(() => registerPiChalinUnsafe(pi)).pipe(Effect.withSpan("api.register")));
}

function registerPiChalinUnsafe(pi: ExtensionAPI): void {
  if (process.env[PI_CHALIN_CHILD_ENV] === "1" || process.env[PI_CHALIN_DISABLED_ENV] === "1") return;

  registerChalinCommands(pi);
  registerChalinTools(pi);
  registerChalinAutoRouter(pi);
  registerBackgroundJobCompletionNotifier(pi);

  pi.on("session_start", (_event, ctx) => {
    resetRuntimeState();
    if (!ctx.hasUI) return;
    setChalinStatus(ctx, { kind: "idle" });
  });
}

export { PI_CHALIN_CHILD_ENV, PI_CHALIN_DISABLED_ENV };
export { AgentCatalog, parseFrontmatter } from "./agents/agents.ts";
export { ArtifactStore } from "./artifacts/artifacts.ts";
export { DEFAULT_CONFIG, approvalDecision, loadEffectiveConfig, setAgentModelOverride, setAgentThinkingOverride, writeProjectConfig, writeUserConfig } from "./config/config.ts";
export { ChalinKernel } from "./kernel/kernel.ts";
export { MemoryStore, createMemoryCandidate } from "./memory/memory.ts";
export { EngramMemoryStore, createConfiguredMemoryStore, resolveMemoryBackendStatus } from "./memory/memory-provider.ts";
export { MockWorkerRunner, SdkWorkerRunner, parseAgentOutput } from "./runner/runner.ts";
export { resolveChalinPaths } from "./config/paths.ts";
export { SkillCatalog, SkillMetricsStore, auditSkill, loadSkillBody, reconcileSkillLifecyclesEffect, recordSkillMetricsEffect, resolveSkillsForStep } from "./skills/skills.ts";
export { runStructuredSkillSelector, validateSkillSelectorOutput } from "./skills/skill-selector.ts";
export type { AgentDefinition, AgentMemoryPolicy, AgentThinkingLevel, RouteDecision, RoutePlan, RunState, MemoryCandidate, MemoryRecord, SkillDefinition, ResolvedSkill, RejectedSkill } from "./domain/schemas.ts";
export type { MemoryProvider } from "./config/config.ts";
