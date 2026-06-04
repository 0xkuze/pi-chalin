import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeBackgroundJobsForFooter } from "../runtime/background-jobs.ts";

const CHALIN_STATUS_KEY = "pi-chalin";

export type ChalinFooterState =
  | { kind: "idle" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "running"; intent: string; agent: string; completed: number; total: number }
  | { kind: "synthesizing" }
  | { kind: "complete"; intent?: string }
  | { kind: "stopped" }
  | { kind: "failed" };

export function setChalinStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui"> & { cwd?: string }, state: ChalinFooterState | undefined): void {
  if (!ctx.hasUI) return;
  const footer = state ? chalinFooterText(state) : undefined;
  const jobs = ctx.cwd ? summarizeBackgroundJobsForFooter(ctx.cwd) : undefined;
  const text = [footer, jobs].filter(Boolean).join(" | ");
  ctx.ui.setStatus(CHALIN_STATUS_KEY, text || undefined);
}

export function chalinFooterText(state: ChalinFooterState, _frame = 0): string {
  if (state.kind === "idle") return "chalin idle";
  if (state.kind === "off") return "chalin off";
  if (state.kind === "on") return "chalin on";
  if (state.kind === "synthesizing") return "chalin synthesizing";
  if (state.kind === "complete") return `chalin complete${state.intent ? ` ${state.intent}` : ""}`;
  if (state.kind === "stopped") return "chalin stopped";
  if (state.kind === "failed") return "chalin failed";
  return `chalin ${state.intent} ${state.completed}/${state.total} ${state.agent}`;
}
