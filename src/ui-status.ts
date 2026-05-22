import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOOTER_FRAMES = ["◆", "◇"];
const FOOTER_ANIMATION_MS = 650;
const LEGACY_CONTROL_WIDGET_KEY = "pi-chalin-control";

let footerTimer: ReturnType<typeof setInterval> | undefined;
let footerFrame = 0;
let footerTarget: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;
let footerState: ChalinFooterState = { kind: "idle" };

export type ChalinFooterState =
  | { kind: "idle" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "running"; intent: string; agent: string; completed: number; total: number }
  | { kind: "synthesizing" }
  | { kind: "complete"; intent?: string }
  | { kind: "stopped" }
  | { kind: "failed" };

export function clearLegacyChalinControlWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(LEGACY_CONTROL_WIDGET_KEY, undefined);
}

export function setChalinStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, state: ChalinFooterState | string | undefined): void {
  if (!ctx.hasUI) return;
  if (state === undefined) {
    stopFooterAnimation();
    ctx.ui.setStatus("pi-chalin", undefined);
    return;
  }
  footerTarget = ctx;
  footerState = typeof state === "string" ? parseLegacyChalinStatus(state) : state;
  renderChalinFooterStatus();
  if (footerState.kind === "running" || footerState.kind === "synthesizing") startFooterAnimation();
  else stopFooterAnimation(false);
}

export function chalinFooterText(state: ChalinFooterState, frame = 0): string {
  if (state.kind === "idle") return "chalin ◦ idle";
  if (state.kind === "off") return "chalin × off";
  if (state.kind === "on") return "chalin ◦ ready";
  if (state.kind === "stopped") return "chalin ■ stopped";
  if (state.kind === "failed") return "chalin × failed";
  if (state.kind === "complete") return state.intent ? `chalin ✓ ${state.intent}` : "chalin ✓ complete";
  if (state.kind === "synthesizing") return `chalin ${FOOTER_FRAMES[frame % FOOTER_FRAMES.length]} synthesizing`;
  return `chalin ${FOOTER_FRAMES[frame % FOOTER_FRAMES.length]} ${state.intent} · ${state.agent} ${state.completed}/${state.total}`;
}

function parseLegacyChalinStatus(text: string): ChalinFooterState {
  if (/off$/i.test(text)) return { kind: "off" };
  if (/on$/i.test(text)) return { kind: "on" };
  if (/idle$/i.test(text)) return { kind: "idle" };
  if (/stopped$/i.test(text)) return { kind: "stopped" };
  if (/failed$/i.test(text)) return { kind: "failed" };
  if (/consolidating|synth/i.test(text)) return { kind: "synthesizing" };
  if (/running$/i.test(text)) return { kind: "running", intent: "working", agent: text.replace(/^chalin:\s*/i, "").replace(/\s*running$/i, ""), completed: 0, total: 1 };
  return { kind: "idle" };
}

function startFooterAnimation(): void {
  if (footerTimer) return;
  footerTimer = setInterval(() => {
    footerFrame += 1;
    renderChalinFooterStatus();
  }, FOOTER_ANIMATION_MS);
  timerUnref(footerTimer);
}

function stopFooterAnimation(render = true): void {
  if (footerTimer) {
    clearInterval(footerTimer);
    footerTimer = undefined;
  }
  footerFrame = 0;
  if (render) renderChalinFooterStatus();
}

function renderChalinFooterStatus(): void {
  footerTarget?.ui.setStatus("pi-chalin", chalinFooterText(footerState, footerFrame));
}

function timerUnref(timer: ReturnType<typeof setInterval>): void {
  timer.unref?.();
}
