export function isTransientVerificationStateClaim(text: string): boolean {
  const normalized = normalizeClaimText(text);
  if (!normalized) return false;
  if (!hasVerificationSubject(normalized)) return false;
  if (hasWeakVerificationEvidence(normalized)) return true;
  return hasCurrentStateLanguage(normalized) && hasVerificationOutcome(normalized);
}

export function sanitizeTransientVerificationClaims(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split("\n").map((line) => {
    if (!isTransientVerificationStateClaim(line)) return line;
    warnings.push("transient verification claim was marked unverified");
    return `${line} [unverified transient status; require a real non-dry-run command before reporting as current state]`;
  });
  return { text: lines.join("\n"), warnings };
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasVerificationSubject(text: string): boolean {
  return /\b(test|tests|suite|specs?|typecheck|build|lint|evals?|ci|verification|validation|pruebas?|tests?|validacion|verificacion)\b/.test(text);
}

function hasWeakVerificationEvidence(text: string): boolean {
  return /\b(dry[- ]?run|preview|inventory|inventario|grep count|partial logs?|logs? parciales?|not executed|no ejecutad[oa]s?|would run|no corrid[oa]s?|head -|tail -)\b/.test(text);
}

function hasCurrentStateLanguage(text: string): boolean {
  return /\b(currently|current|now|today|actualmente|actual|ahora|hoy|at the moment|en este momento)\b/.test(text);
}

function hasVerificationOutcome(text: string): boolean {
  return /\b(fail(?:ed|ing|s)?|pass(?:ed|ing|es)?|red|green|broken|failing|passing|fall(?:a|an|ando|o)|pasa(?:n|ndo)?|rojo|verde|exitos[oa]s?|fallid[oa]s?)\b/.test(text);
}
