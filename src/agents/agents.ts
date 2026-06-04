import * as fs from "node:fs";
import * as path from "node:path";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import {
  type AgentCatalogDiagnostics,
  type AgentCapability,
  type AgentConcern,
  type AgentDefinition,
  type AgentMemoryPolicy,
  type AgentMemoryWritePolicy,
  type AgentScope,
  isAgentConcern,
  isAgentCapability,
  isAgentScope,
  isAgentThinkingLevel,
} from "../domain/schemas.ts";
import { errorMessage } from "../utils/guards.ts";

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

export interface AgentCatalogLoadOptions extends ChalinPathsOptions {}

export interface AgentResolution {
  agent?: AgentDefinition;
  error?: string;
}

export class AgentCatalog {
  private readonly byScope: Record<AgentScope, Map<string, AgentDefinition>>;
  readonly diagnostics: AgentCatalogDiagnostics;

  private constructor(
    byScope: Record<AgentScope, Map<string, AgentDefinition>>,
    diagnostics: AgentCatalogDiagnostics,
  ) {
    this.byScope = byScope;
    this.diagnostics = diagnostics;
  }

  static load(options: AgentCatalogLoadOptions): AgentCatalog {
    const paths = resolveChalinPaths(options);
    const diagnostics: AgentCatalogDiagnostics = { warnings: [], errors: [] };
    const byScope: Record<AgentScope, Map<string, AgentDefinition>> = {
      "built-in": new Map(),
      project: new Map(),
      user: new Map(),
    };

    loadAgentDir(paths.builtInAgentsDir, "built-in", byScope["built-in"], diagnostics);
    loadAgentDir(paths.userAgentsDir, "user", byScope.user, diagnostics);
    loadAgentDir(paths.projectAgentsDir, "project", byScope.project, diagnostics);

    return new AgentCatalog(byScope, diagnostics);
  }

  list(scope?: AgentScope): AgentDefinition[] {
    const scopes = scope ? [scope] : (["project", "user", "built-in"] as const);
    return scopes.flatMap((currentScope) => [...this.byScope[currentScope].values()]).sort(compareAgents);
  }

  listExecutable(): AgentDefinition[] {
    return this.list().filter((agent) => !agent.diagnostics.some((diag) => diag.startsWith("invalid:")));
  }

  resolve(reference: string): AgentResolution {
    const trimmed = reference.trim();
    if (!trimmed) return { error: "Agent reference must not be empty." };

    const slashIndex = trimmed.indexOf("/");
    if (slashIndex !== -1) {
      const maybeScope = trimmed.slice(0, slashIndex);
      const name = trimmed.slice(slashIndex + 1);
      if (!isAgentScope(maybeScope)) {
        return { error: `Unknown agent scope '${maybeScope}'. Use project/name, user/name, or built-in/name.` };
      }
      const agent = this.byScope[maybeScope].get(name);
      return agent ? { agent } : { error: `Agent '${name}' not found in ${maybeScope} scope.` };
    }

    for (const scope of ["project", "user", "built-in"] as const) {
      const agent = this.byScope[scope].get(trimmed);
      if (agent) return { agent };
    }

    return { error: `Agent '${trimmed}' not found. Available agents: ${this.list().map((agent) => `${agent.scope}/${agent.name}`).join(", ") || "none"}.` };
  }

  resolveMany(references: string[]): { agents: AgentDefinition[]; errors: string[] } {
    const agents: AgentDefinition[] = [];
    const errors: string[] = [];
    for (const reference of references) {
      const result = this.resolve(reference);
      if (result.agent) agents.push(result.agent);
      if (result.error) errors.push(result.error);
    }
    return { agents, errors };
  }
}

function compareAgents(a: AgentDefinition, b: AgentDefinition): number {
  const scopeRank: Record<AgentScope, number> = { project: 0, user: 1, "built-in": 2 };
  return scopeRank[a.scope] - scopeRank[b.scope] || a.name.localeCompare(b.name);
}

function loadAgentDir(
  dir: string,
  scope: AgentScope,
  target: Map<string, AgentDefinition>,
  diagnostics: AgentCatalogDiagnostics,
): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.errors.push(`Failed to read ${scope} agents dir '${dir}': ${errorMessage(error)}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const loaded = loadAgentFile(filePath, scope);
    for (const warning of loaded.diagnostics) diagnostics.warnings.push(`${filePath}: ${warning}`);
    if (target.has(loaded.name)) {
      diagnostics.warnings.push(`${filePath}: duplicate agent '${loaded.name}' in ${scope} scope; later file overwrote earlier definition.`);
    }
    target.set(loaded.name, loaded);
  }
}

function loadAgentFile(filePath: string, scope: AgentScope): AgentDefinition {
  const diagnostics: string[] = [];
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    diagnostics.push(`invalid: failed to read agent file: ${errorMessage(error)}`);
  }

  const parsed = parseFrontmatter(raw);
  const fileName = path.basename(filePath, ".md");
  const name = (parsed.frontmatter.name || fileName).trim();
  const concern = parseConcern(parsed.frontmatter.concern, diagnostics, filePath);
  const capabilities = parseCapabilities(parsed.frontmatter.capabilities, concern, parsed.frontmatter.tools, diagnostics);
  const memory = parseMemoryPolicy(parsed.frontmatter, diagnostics);
  const model = (parsed.frontmatter.model || "inherit").trim() || "inherit";
  const thinking = parseThinkingLevel(parsed.frontmatter.thinking ?? parsed.frontmatter["thinking-level"], diagnostics);
  const tools = parseStringList(parsed.frontmatter.tools);
  const description = (parsed.frontmatter.description || `${name} agent`).trim();

  if (!name) diagnostics.push("invalid: agent name must not be empty.");
  if (!parsed.body.trim()) diagnostics.push("invalid: agent system prompt body must not be empty.");

  return {
    name,
    scope,
    concern,
    capabilities,
    description,
    model,
    thinking,
    tools,
    memory,
    systemPrompt: parsed.body.trim(),
    sourcePath: filePath,
    diagnostics,
  };
}

function parseThinkingLevel(value: string | undefined, diagnostics: string[]) {
  const thinking = (value || "inherit").trim();
  if (isAgentThinkingLevel(thinking)) return thinking;
  diagnostics.push(`invalid: unknown thinking level '${thinking}'. Use inherit, off, minimal, low, medium, high, or xhigh.`);
  return "inherit";
}

function parseCapabilities(value: string | undefined, concern: AgentConcern, tools: string | undefined, diagnostics: string[]): AgentCapability[] {
  const raw = parseStringList(value);
  const capabilities = raw.length > 0 ? raw : defaultCapabilities(concern, parseStringList(tools));
  const valid: AgentCapability[] = [];
  for (const capability of capabilities) {
    if (isAgentCapability(capability)) valid.push(capability);
    else diagnostics.push(`invalid: unknown capability '${capability}'.`);
  }
  return [...new Set(valid)];
}

function defaultCapabilities(concern: AgentConcern, tools: string[]): AgentCapability[] {
  const fromTools: AgentCapability[] = [];
  if (tools.some((tool) => ["read", "ls"].includes(tool))) fromTools.push("inspect-files");
  if (tools.some((tool) => ["grep", "find"].includes(tool))) fromTools.push("search-files");
  if (tools.includes("bash")) fromTools.push("run-safe-bash");
  if (tools.includes("edit")) fromTools.push("edit-files");
  if (tools.includes("write")) fromTools.push("write-new-files");
  const byConcern: Partial<Record<AgentConcern, AgentCapability[]>> = {
    recon: ["inspect-files", "search-files", "memory-read"],
    research: ["inspect-files", "search-files", "external-context", "memory-read"],
    "context-building": ["inspect-files", "search-files", "memory-read", "memory-write"],
    planning: ["inspect-files", "search-files", "memory-read", "coordinate"],
    implementation: ["inspect-files", "search-files", "run-safe-bash", "validate", "edit-files", "write-new-files", "memory-read", "memory-write", "coordinate"],
    review: ["inspect-files", "search-files", "run-safe-bash", "validate", "memory-read", "memory-write"],
    "conflict-resolution": ["inspect-files", "search-files", "run-safe-bash", "validate", "edit-files", "memory-read", "memory-write"],
    "decision-consistency": ["inspect-files", "search-files", "memory-read", "coordinate"],
    delegation: ["inspect-files", "search-files", "coordinate"],
    "memory-curation": ["memory-read", "memory-write"],
  };
  return [...new Set([...(byConcern[concern] ?? []), ...fromTools])];
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };

  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const frontmatter: Record<string, string> = {};

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2]?.trim() ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1]!] = value;
  }

  return { frontmatter, body };
}

function parseConcern(value: string | undefined, diagnostics: string[], filePath: string): AgentConcern {
  const concern = (value || "delegation").trim();
  if (isAgentConcern(concern)) return concern;
  diagnostics.push(`invalid: unknown concern '${concern}' in '${filePath}'.`);
  return "delegation";
}

function parseMemoryPolicy(frontmatter: Record<string, string>, diagnostics: string[]): AgentMemoryPolicy {
  const rawWrite = (frontmatter["memory-write"] || "candidate").trim();
  const write: AgentMemoryWritePolicy = rawWrite === "never" || rawWrite === "candidate" || rawWrite === "approved" ? rawWrite : "candidate";
  if (write !== rawWrite) diagnostics.push(`Invalid memory-write '${rawWrite}'; using 'candidate'.`);

  return {
    read: parseBoolean(frontmatter["memory-read"], true),
    write,
    categories: parseStringList(frontmatter["memory-categories"]),
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  return fallback;
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
}
