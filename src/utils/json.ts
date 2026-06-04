import { isRecord } from "./guards.ts";

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = extractJsonObjectText(text);
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObjectText(text: string): string | undefined {
  const trimmed = stripMarkdownJsonFence(text);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return firstBalancedJsonObject(trimmed);
}

export function compactString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function firstBalancedJsonObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}
