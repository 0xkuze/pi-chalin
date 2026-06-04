export function compactText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (normalized.length <= max) return normalized;
  if (max === 1) return "…";
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}
