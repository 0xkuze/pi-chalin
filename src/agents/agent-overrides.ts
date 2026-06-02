import type { AgentThinkingLevel } from "../domain/schemas.ts";

export const sessionModelOverrides = new Map<string, string>();
export const sessionThinkingOverrides = new Map<string, AgentThinkingLevel>();

export function mergedSessionModelOverrides(configOverrides: Record<string, string>): Record<string, string> {
  return { ...configOverrides, ...Object.fromEntries(sessionModelOverrides.entries()) };
}

export function mergedSessionThinkingOverrides(configOverrides: Record<string, AgentThinkingLevel>): Record<string, AgentThinkingLevel> {
  return { ...configOverrides, ...Object.fromEntries(sessionThinkingOverrides.entries()) };
}
