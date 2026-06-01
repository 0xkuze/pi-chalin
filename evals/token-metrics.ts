export interface TokenUsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export function activeTokenTotal(usage: TokenUsageLike): number {
  return usage.input + usage.output + usage.cacheWrite;
}
