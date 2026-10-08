/**
 * Shared helper to verify word boundaries (avoids matching "gift" for "if").
 */
export function isBoundary(src, idx, len) {
  const prev = idx === 0 ? '' : src[idx - 1];
  const next = idx + len >= src.length ? '' : src[idx + len];
  return !/[a-zA-Z0-9_$]/.test(prev) && !/[a-zA-Z0-9_$]/.test(next);
}
