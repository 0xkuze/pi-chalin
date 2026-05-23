import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { setAgentModelOverride, setAgentThinkingOverride, type ModelPersistenceTarget } from "./config.ts";
import type { AgentDefinition, AgentThinkingLevel } from "./schemas.ts";

const MODEL_PICKER_VISIBLE_ROWS = 12;

type AvailableModel = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>>[number];

interface AgentModelOption {
  value: string;
  provider?: string;
  id?: string;
  name?: string;
  searchText: string;
}

export async function openAgentManager(
  ctx: ExtensionContext,
  agents: AgentDefinition[],
  sessionModelOverrides: Map<string, string>,
  sessionThinkingOverrides: Map<string, AgentThinkingLevel>,
  persistedModelOverrides: Record<string, string> = {},
  persistedThinkingOverrides: Record<string, AgentThinkingLevel> = {},
): Promise<void> {
  const format = (agent: AgentDefinition) => {
    const key = `${agent.scope}/${agent.name}`;
    const model = effectiveAgentModel(agent, sessionModelOverrides, persistedModelOverrides);
    const thinking = effectiveAgentThinking(agent, sessionThinkingOverrides, persistedThinkingOverrides);
    return `${key} · ${agent.concern} · ${model} · thinking ${thinking}`;
  };

  if (!ctx.hasUI) {
    ctx.ui.notify(agents.map(format).join("\n") || "No agents found", "info");
    return;
  }

  const selected = await ctx.ui.select("Agents", agents.map(format));
  if (!selected) return;
  const agent = agents.find((candidate) => selected.startsWith(`${candidate.scope}/${candidate.name} ·`));
  if (!agent) return;

  const action = await ctx.ui.select(`${agent.scope}/${agent.name}`, ["Inspect", "Change model", "Change thinking", "Reset model", "Reset thinking", "Close"]);
  if (action === "Change model") return openAgentModelPicker(ctx, agent, sessionModelOverrides, persistedModelOverrides);
  if (action === "Change thinking") return openAgentThinkingPicker(ctx, agent, sessionThinkingOverrides);
  if (action === "Reset model") {
    const key = `${agent.scope}/${agent.name}`;
    if (!await confirmAgentReset(ctx, key, "model")) return;
    sessionModelOverrides.delete(key);
    setAgentModelOverride({ cwd: ctx.cwd }, key, undefined, defaultPersistenceTarget(agent.scope) === "user" ? "user" : "project");
    ctx.ui.notify(`${key} reset to inherit.`, "info");
    return;
  }
  if (action === "Reset thinking") {
    const key = `${agent.scope}/${agent.name}`;
    if (!await confirmAgentReset(ctx, key, "thinking")) return;
    sessionThinkingOverrides.delete(key);
    setAgentThinkingOverride({ cwd: ctx.cwd }, key, undefined, defaultPersistenceTarget(agent.scope) === "user" ? "user" : "project");
    ctx.ui.notify(`${key} thinking reset to inherit.`, "info");
    return;
  }
  if (action === "Inspect") {
    ctx.ui.notify(
      [
        `${agent.scope}/${agent.name}`,
        agent.description,
        `concern: ${agent.concern}`,
        `model: ${effectiveAgentModel(agent, sessionModelOverrides, persistedModelOverrides)}`,
        `thinking: ${effectiveAgentThinking(agent, sessionThinkingOverrides, persistedThinkingOverrides)}`,
        `tools: ${agent.tools.join(", ") || "none"}`,
        `memory: read=${agent.memory.read}, write=${agent.memory.write}`,
        agent.sourcePath ? `source: ${agent.sourcePath}` : undefined,
        "keys: ↑/↓ select · enter open · esc close",
      ].filter((line): line is string => Boolean(line)).join("\n"),
      agent.diagnostics.length > 0 ? "warning" : "info",
    );
  }
}

async function confirmAgentReset(ctx: ExtensionContext, key: string, field: "model" | "thinking"): Promise<boolean> {
  return ctx.ui.confirm(
    field === "model" ? "Reset Agent Model" : "Reset Agent Thinking",
    `This removes the saved ${field} override for ${key} and restores inherited behavior.\n\nContinue?`,
  );
}

export async function openAgentThinkingPicker(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  sessionThinkingOverrides: Map<string, AgentThinkingLevel>,
): Promise<void> {
  const key = `${agent.scope}/${agent.name}`;
  const options: AgentThinkingLevel[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
  const selected = ctx.hasUI ? await ctx.ui.select(`Thinking for ${key}`, options) as AgentThinkingLevel | undefined : undefined;
  if (!selected) return;

  const target = await choosePersistenceTarget(ctx, agent.scope);
  if (!target) return;
  if (target === "session") {
    if (selected === "inherit") sessionThinkingOverrides.delete(key);
    else sessionThinkingOverrides.set(key, selected);
  } else {
    setAgentThinkingOverride({ cwd: ctx.cwd }, key, selected, target);
  }
  ctx.ui.notify(`${key} thinking set to ${selected} (${target}).`, "info");
}

export async function openAgentModelPicker(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  sessionModelOverrides: Map<string, string>,
  persistedModelOverrides: Record<string, string> = {},
): Promise<void> {
  const key = `${agent.scope}/${agent.name}`;
  const available = loadAvailableAgentModels(ctx);
  const current = effectiveAgentModel(agent, sessionModelOverrides, persistedModelOverrides);
  const options = buildAgentModelOptions(available, current);
  const selected = ctx.hasUI ? await openAgentModelSearchPicker(ctx, `Model for ${key}`, options, current) : undefined;
  if (!selected) return;
  if (!options.some((option) => option.value === selected)) {
    ctx.ui.notify(`Model '${selected}' is not available.`, "error");
    return;
  }

  const target = await choosePersistenceTarget(ctx, agent.scope);
  if (!target) return;
  if (target === "session") {
    if (selected === "inherit") sessionModelOverrides.delete(key);
    else sessionModelOverrides.set(key, selected);
  } else {
    setAgentModelOverride({ cwd: ctx.cwd }, key, selected === "inherit" ? undefined : selected, target);
  }
  ctx.ui.notify(`${key} model set to ${selected} (${target}).`, "info");
}

function effectiveAgentModel(
  agent: AgentDefinition,
  sessionModelOverrides: Map<string, string>,
  persistedModelOverrides: Record<string, string>,
): string {
  const key = `${agent.scope}/${agent.name}`;
  return sessionModelOverrides.get(key)
    ?? persistedModelOverrides[key]
    ?? persistedModelOverrides[agent.name]
    ?? agent.model;
}

function effectiveAgentThinking(
  agent: AgentDefinition,
  sessionThinkingOverrides: Map<string, AgentThinkingLevel>,
  persistedThinkingOverrides: Record<string, AgentThinkingLevel>,
): AgentThinkingLevel {
  const key = `${agent.scope}/${agent.name}`;
  return sessionThinkingOverrides.get(key)
    ?? persistedThinkingOverrides[key]
    ?? persistedThinkingOverrides[agent.name]
    ?? agent.thinking
    ?? "inherit";
}

function loadAvailableAgentModels(ctx: ExtensionContext): AvailableModel[] {
  ctx.modelRegistry.refresh();
  const loadError = ctx.modelRegistry.getError?.();
  if (ctx.hasUI && loadError) ctx.ui.notify(`Warning: errors loading models.json:\n${loadError}`, "warning");
  return ctx.modelRegistry.getAvailable();
}

function buildAgentModelOptions(models: AvailableModel[], current: string | undefined): AgentModelOption[] {
  const normalizedCurrent = current && current !== "inherit" ? current : undefined;
  const sortedModels = [...models].sort((a, b) => {
    const aValue = `${a.provider}/${a.id}`;
    const bValue = `${b.provider}/${b.id}`;
    if (normalizedCurrent) {
      if (aValue === normalizedCurrent && bValue !== normalizedCurrent) return -1;
      if (bValue === normalizedCurrent && aValue !== normalizedCurrent) return 1;
    }
    const provider = a.provider.localeCompare(b.provider);
    return provider || a.id.localeCompare(b.id);
  });

  return [
    { value: "inherit", searchText: "inherit default parent agent model" },
    ...sortedModels.map((model) => ({
      value: `${model.provider}/${model.id}`,
      provider: model.provider,
      id: model.id,
      name: model.name,
      searchText: `${model.provider} ${model.id} ${model.provider}/${model.id} ${model.name ?? ""}`,
    })),
  ];
}

async function openAgentModelSearchPicker(
  ctx: ExtensionContext,
  title: string,
  options: AgentModelOption[],
  current: string | undefined,
): Promise<string | undefined> {
  if (options.length <= 1) {
    ctx.ui.notify("No authenticated models are available. Use /login or configure ~/.pi/agent/models.json.", "warning");
    return undefined;
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new AgentModelPickerComponent(tui, theme, title, options, current, done));
}

class AgentModelPickerComponent extends Container implements Focusable {
  private searchInput = new Input();
  private listContainer = new Container();
  private filteredOptions: AgentModelOption[];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    private tui: TUI,
    private theme: Theme,
    title: string,
    private options: AgentModelOption[],
    private current: string | undefined,
    private done: (selected: string | undefined) => void,
  ) {
    super();
    this.filteredOptions = options;
    this.selectedIndex = Math.max(0, options.findIndex((option) => option.value === (current ?? "inherit")));

    this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        this.keyHint("↑/↓", "navigate")
          + "  "
          + this.keyHint("enter", "select")
          + "  "
          + this.keyHint("escape/ctrl+c", "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));

    this.updateList();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredOptions.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredOptions.length - 1 : this.selectedIndex - 1;
        this.updateList();
      }
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredOptions.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredOptions.length - 1 ? 0 : this.selectedIndex + 1;
        this.updateList();
      }
    } else if (kb.matches(keyData, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MODEL_PICKER_VISIBLE_ROWS);
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(Math.max(0, this.filteredOptions.length - 1), this.selectedIndex + MODEL_PICKER_VISIBLE_ROWS);
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      this.done(this.filteredOptions[this.selectedIndex]?.value);
      return;
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
      return;
    } else {
      this.searchInput.handleInput(keyData);
      this.filterOptions(this.searchInput.getValue());
      this.updateList();
    }
    this.tui.requestRender();
  }

  private filterOptions(query: string): void {
    this.filteredOptions = query
      ? fuzzyFilter(this.options, query, (option) => option.searchText)
      : this.options;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredOptions.length - 1));
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.filteredOptions.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 1, 0));
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MODEL_PICKER_VISIBLE_ROWS / 2), this.filteredOptions.length - MODEL_PICKER_VISIBLE_ROWS),
    );
    const endIndex = Math.min(startIndex + MODEL_PICKER_VISIBLE_ROWS, this.filteredOptions.length);

    for (let index = startIndex; index < endIndex; index += 1) {
      const option = this.filteredOptions[index];
      if (!option) continue;
      const isSelected = index === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const text = formatAgentModelOption(option);
      const currentMarker = option.value === (this.current ?? "inherit") ? this.theme.fg("success", " ✓") : "";
      this.listContainer.addChild(new Text(prefix + (isSelected ? this.theme.fg("accent", text) : this.theme.fg("text", text)) + currentMarker, 1, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredOptions.length) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredOptions.length})`), 1, 0));
    }
  }

  private keyHint(key: string, description: string): string {
    return this.theme.fg("dim", key) + this.theme.fg("muted", ` ${description}`);
  }
}

function formatAgentModelOption(option: AgentModelOption): string {
  if (option.value === "inherit") return "inherit";
  const name = option.name && option.name !== option.id ? ` · ${option.name}` : "";
  return `${option.provider}/${option.id}${name}`;
}

async function choosePersistenceTarget(ctx: ExtensionContext, scope: AgentDefinition["scope"]): Promise<ModelPersistenceTarget | undefined> {
  const preferred = defaultPersistenceTarget(scope);
  const options: ModelPersistenceTarget[] = [preferred, ...(["session", "project", "user"] as const).filter((item) => item !== preferred)];
  const selected = ctx.hasUI ? await ctx.ui.select("Persist model selection", options) : preferred;
  return selected as ModelPersistenceTarget | undefined;
}

function defaultPersistenceTarget(scope: AgentDefinition["scope"]): Exclude<ModelPersistenceTarget, "session"> {
  return scope === "project" ? "project" : "user";
}
