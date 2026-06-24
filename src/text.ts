export const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "unnamed" : slug;
};

// Reads KEY=value assignments. Handles `export KEY=`, unquoted values, and
// quoted values (outer quotes stripped). Does not expand variable references.
export const readEnvVar = (content: string, key: string): string | undefined => {
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const setEnvVar = (lines: ReadonlyArray<string>, key: string, value: string): Array<string> => {
  const pattern = new RegExp(`^#?\\s*${escapeRegExp(key)}=`);
  const next = [...lines];
  const index = next.findIndex((line) => pattern.test(line));
  if (index === -1) {
    next.push(`${key}=${value}`);
  } else {
    next[index] = `${key}=${value}`;
  }
  return next;
};

export const nextFreePort = (base: number, used: ReadonlySet<number>): number => {
  let port = base;
  while (used.has(port)) port += 1;
  return port;
};

export const applyTemplate = (
  value: string,
  vars: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>,
): string =>
  value
    .replace(/\{\{env:([A-Za-z0-9_]+)\}\}/g, (match, key: string) => env[key] ?? match)
    .replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => vars[key] ?? match);
