import { pinyin } from "pinyin-pro";

const SEARCH_SPLIT_REGEX = /[\s\-_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/u;
const SEARCH_REMOVE_REGEX = /[\s\-_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/gu;
const PINYIN_CACHE = new Map<string, { full: string; initials: string }>();

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
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;

  const sourceText = fields.filter(Boolean).join(" ");
  const haystack = normalizeText(sourceText);
  if (!haystack) return false;

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
