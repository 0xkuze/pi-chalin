import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export function setChalinStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, _state: ChalinFooterState | undefined): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(CHALIN_STATUS_KEY, undefined);
}

export function chalinFooterText(_state: ChalinFooterState, _frame = 0): string {
  return "";
}
