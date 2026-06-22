import { expect, test } from "bun:test";
import { applyTemplate, nextFreePort, readEnvVar, resolveVersion, setEnvVar, slugify } from "./text.ts";

test("slugify collapses non-alphanumerics and trims", () => {
  expect(slugify("worktree/brave-river")).toBe("worktree_brave_river");
  expect(slugify("Feature/FOO 123")).toBe("feature_foo_123");
  expect(slugify("--edge--")).toBe("edge");
});

test("readEnvVar ignores comments and blanks, trims value", () => {
  const env = "# comment\n\nPORT = 3000 \nDATABASE_URL=postgres://x/db\n";
  expect(readEnvVar(env, "PORT")).toBe("3000");
  expect(readEnvVar(env, "DATABASE_URL")).toBe("postgres://x/db");
  expect(readEnvVar(env, "MISSING")).toBeUndefined();
});

test("setEnvVar replaces in place (even commented), else appends", () => {
  expect(setEnvVar(["PORT=3000", "X=1"], "PORT", "3001")).toEqual(["PORT=3001", "X=1"]);
  expect(setEnvVar(["# PORT=3000"], "PORT", "3001")).toEqual(["PORT=3001"]);
  expect(setEnvVar(["X=1"], "PORT", "3001")).toEqual(["X=1", "PORT=3001"]);
});

test("nextFreePort returns lowest free >= base", () => {
  expect(nextFreePort(3000, new Set())).toBe(3000);
  expect(nextFreePort(3000, new Set([3000, 3001]))).toBe(3002);
  expect(nextFreePort(3000, new Set([3001]))).toBe(3000);
});

test("resolveVersion returns the version field, else a sane fallback", () => {
  expect(resolveVersion('{"name":"githog","version":"0.1.0"}')).toBe("0.1.0");
  expect(resolveVersion('{"name":"githog"}')).toBe("0.0.0");
  expect(resolveVersion('{"name":"githog","version":""}')).toBe("0.0.0");
  expect(resolveVersion("not json at all")).toBe("0.0.0");
});

test("applyTemplate substitutes vars and env, leaves unknown tokens", () => {
  const vars = { slug: "feat_x", targetDir: "/wt/x" };
  const env = { DATABASE_URL: "postgres://x/app_feat_x" };
  expect(applyTemplate("db_{{slug}}", vars, env)).toBe("db_feat_x");
  expect(applyTemplate("{{env:DATABASE_URL}}", vars, env)).toBe("postgres://x/app_feat_x");
  expect(applyTemplate("{{unknown}}", vars, env)).toBe("{{unknown}}");
  expect(applyTemplate("{{env:NOPE}}", vars, env)).toBe("{{env:NOPE}}");
});
