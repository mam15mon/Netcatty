import { pinyin } from "pinyin-pro";

const SEARCH_SPLIT_REGEX = /[\s\p{Pd}_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/u;
const SEARCH_REMOVE_REGEX = /[\s\p{Pd}_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/gu;
const PINYIN_CACHE = new Map<string, { full: string; initials: string }>();
const IPV4_LIKE_REGEX = /^\d{1,3}(?:\.\d{1,3})+$/;

function normalizeText(input: string): string {
  return input.normalize("NFKC").toLowerCase().trim();
}

function compactText(input: string): string {
  return normalizeText(input).replace(SEARCH_REMOVE_REGEX, "");
}

function getPinyinVariants(sourceText: string): { full: string; initials: string } {
  const cacheKey = normalizeText(sourceText);
  const cached = PINYIN_CACHE.get(cacheKey);
  if (cached) return cached;

  let full = "";
  let initials = "";

  try {
    full = compactText(
      pinyin(sourceText, {
        toneType: "none",
      }),
    );
    initials = compactText(
      pinyin(sourceText, {
        pattern: "first",
        toneType: "none",
      }),
    );
  } catch {
    // ignore conversion failures
  }

  const next = { full, initials };
  PINYIN_CACHE.set(cacheKey, next);
  return next;
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  return normalized.split(SEARCH_SPLIT_REGEX).filter(Boolean);
}

export function matchesSearchQuery(
  query: string,
  ...fields: Array<string | null | undefined>
): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;

  const normalizedFields = fields
    .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    .map((field) => normalizeText(field));
  if (normalizedFields.length === 0) return false;

  // For dotted numeric input (IPv4-like), require contiguous literal match.
  if (IPV4_LIKE_REGEX.test(normalizedQuery)) {
    return normalizedFields.some((field) => field.includes(normalizedQuery));
  }

  const sourceText = normalizedFields.join(" ");
  const haystack = sourceText;
  if (haystack.includes(normalizedQuery)) {
    return true;
  }

  const haystackCompact = compactText(sourceText);
  const compactQuery = compactText(normalizedQuery);
  if (compactQuery && haystackCompact.includes(compactQuery)) {
    return true;
  }

  const tokens = tokenizeSearchQuery(normalizedQuery);
  if (tokens.length === 0) return true;

  if (tokens.every((token) => haystack.includes(token))) {
    return true;
  }

  const hasLatinToken = tokens.some((token) => /[a-z]/i.test(token));
  if (!hasLatinToken) return false;

  const { full, initials } = getPinyinVariants(sourceText);
  if (!full && !initials) return false;

  return tokens.every((token) => {
    if (haystack.includes(token)) return true;
    const compactToken = compactText(token);
    return (
      (full && full.includes(compactToken)) ||
      (initials && initials.includes(compactToken))
    );
  });
}
