import { expect, test } from "bun:test";
import { formatVersion, resolveVersion, VERSION_FALLBACK } from "./version.ts";

test("formatVersion formats a present version as 'githog x.y.z'", () => {
  expect(formatVersion({ version: "1.2.3" })).toBe("githog 1.2.3");
  expect(formatVersion({ name: "githog", version: "0.1.0" })).toBe("githog 0.1.0");
});

test("formatVersion falls back when version is missing or unparseable", () => {
  expect(formatVersion({})).toBe(`githog ${VERSION_FALLBACK}`);
  expect(formatVersion({ version: 42 })).toBe(`githog ${VERSION_FALLBACK}`);
  expect(formatVersion(undefined)).toBe(`githog ${VERSION_FALLBACK}`);
  expect(formatVersion(null)).toBe(`githog ${VERSION_FALLBACK}`);
});

test("resolveVersion reads githog's own package.json", async () => {
  expect(await resolveVersion()).toBe("githog 0.1.0");
});
