import assert from "node:assert/strict";
import test from "node:test";

import { matchesSearchQuery } from "../lib/searchMatcher.ts";

test("matches mixed Chinese and dash-separated numeric suffix with spaced query", () => {
  assert.equal(
    matchesSearchQuery("山东 6-1", "山东-业务交换机6-1"),
    true,
  );
});

test("matches mixed Chinese and em-dash separator with spaced query", () => {
  assert.equal(
    matchesSearchQuery("山东 6-1", "山东—业务交换机6—1"),
    true,
  );
});

test("matches IPv4-like query only on contiguous dotted address", () => {
  assert.equal(
    matchesSearchQuery("192.168.6.1", "192.168.6.1"),
    true,
  );
  assert.equal(
    matchesSearchQuery("192.168.6.1", "192.168.16.10"),
    false,
  );
});

test("matches compact form across separators", () => {
  assert.equal(
    matchesSearchQuery("prod api 01", "prod-api-01"),
    true,
  );
});
