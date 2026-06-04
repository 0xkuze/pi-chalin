export function normalizeMetricFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}
