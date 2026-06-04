export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
