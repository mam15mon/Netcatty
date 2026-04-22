/**
 * Best-effort regex safety guard for user-provided patterns.
 *
 * Reject nested quantifier shapes such as `(a+)+`, `(a*)*`, `(a+){2,}`
 * that are common catastrophic-backtracking sources.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  const nestedQuantifier = /\([^)]*[+*}]\)[+*?{]/;
  return !nestedQuantifier.test(pattern);
}

