// `githog version` / `--version` support. The version lives in package.json so it
// has a single source of truth; the formatting is split out as a pure function so
// the present/missing cases are unit-testable without touching the filesystem.

export const VERSION_FALLBACK = "0.0.0";

// Pure: turn whatever we parsed out of package.json into the `githog x.y.z` line.
// A missing or non-string `version` degrades to the fallback rather than throwing.
export const formatVersion = (pkg: unknown): string => {
  const version =
    typeof pkg === "object" && pkg !== null && typeof (pkg as Record<string, unknown>).version === "string"
      ? (pkg as Record<string, string>).version
      : VERSION_FALLBACK;
  return `githog ${version}`;
};

// Reads the package.json that ships WITH githog (resolved relative to this module
// via import.meta, NOT process.cwd() — the CLI runs inside arbitrary worktrees).
// Any read/parse failure falls back through formatVersion(undefined).
export const resolveVersion = async (): Promise<string> => {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    return formatVersion(await Bun.file(pkgUrl).json());
  } catch {
    return formatVersion(undefined);
  }
};
