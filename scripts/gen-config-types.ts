#!/usr/bin/env bun
// Generate a self-contained, effect-free `homestead.config.types.d.ts` from the
// real `HomesteadConfig` type in src/types.ts. This is the file `homestead init`
// drops into a consumer repo so a homestead.config.ts can be fully typed with
// NOTHING installed — no `homestead` dependency, no `effect`, no bloat.
//
// Single source of truth: we resolve HomesteadConfig via the TypeScript checker
// and print each property structurally, so schema/type changes flow through on
// the next release. Members that reference effect (lifecycle hooks, onEvent)
// are loosened to effect-free shapes consumers can implement synchronously.
//
//   bun run scripts/gen-config-types.ts            # -> src/homestead.config.types.d.ts
//   bun run scripts/gen-config-types.ts --check    # fail if out of date (CI/release)

import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const typesEntry = join(root, "src", "types.ts");
const eventsEntry = join(root, "src", "events.ts");
const prResolveEntry = join(root, "src", "pr", "resolve.ts");
const outPath = join(root, "src", "generated", "homestead.config.types.d.ts");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

// Lifecycle hooks and onEvent touch `effect` (Effect + HomesteadServices). Consumers
// rarely need the full runtime type and a bare .d.ts has no `effect` to import,
// so we loosen them to unknown-returning callbacks.
const EFFECT_FREE_HOOKS: Record<string, string> = {
  afterSetup: "afterSetup?: ((ctx: WorktreeContext & { readonly plan: Plan }) => unknown) | undefined",
  afterLaunch: "afterLaunch?: ((ctx: HomesteadContext & { readonly paneId: string; }) => unknown) | undefined",
  beforeTeardown:
    'beforeTeardown?: ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly tracked: boolean; readonly spawnedBy?: string; }) => unknown) | undefined',
  afterTeardown:
    'afterTeardown?: ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly reviewLabel?: string; }) => unknown) | undefined',
  onEvent: "onEvent?: ((e: HomesteadEvent) => unknown) | undefined",
};

const program = ts.createProgram([typesEntry, eventsEntry, prResolveEntry], {
  strict: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

const findExport = (entry: string, name: string) => {
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot load ${entry}`);
  const sym = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find((s) => s.name === name);
  if (!sym) throw new Error(`expected export "${name}" in ${entry}`);
  return sym;
};

// Print one exported type as a structural interface body. We expand the type's
// own properties (not nested named types — those stay inlined, which is fine
// for a generated artifact) and never recurse into effect.
const printInterface = (name: string, opts: { effectFreeHooks?: boolean } = {}): string => {
  const sym = findExport(typesEntry, name);
  const type = checker.getDeclaredTypeOfSymbol(sym);
  const props = checker.getPropertiesOfType(type);
  const source = program.getSourceFile(typesEntry)!;
  const lines: string[] = [];
  for (const prop of props) {
    const override = opts.effectFreeHooks ? EFFECT_FREE_HOOKS[prop.name] : undefined;
    if (override !== undefined) {
      lines.push(`  readonly ${override};`);
      continue;
    }
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl ?? source);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const printed = checker.typeToString(propType, decl, FLAGS);
    lines.push(`  readonly ${prop.name}${optional ? "?" : ""}: ${printed};`);
  }
  return `export interface ${name} {\n${lines.join("\n")}\n}`;
};

const printExportedTypeAlias = (entry: string, name: string): string => {
  const sym = findExport(entry, name);
  const decl = sym.declarations?.[0];
  const source = program.getSourceFile(entry)!;
  // Only print the alias node verbatim when it's a literal union (e.g.
  // HomesteadEvent) — those are self-contained. A `typeof X.Type` alias (e.g.
  // PrView) would emit a reference to a name that doesn't exist in the output,
  // so fall through to structural expansion via the checker.
  if (decl !== undefined && ts.isTypeAliasDeclaration(decl) && ts.isUnionTypeNode(decl.type)) {
    const printer = ts.createPrinter({ removeComments: true });
    const printed = printer.printNode(ts.EmitHint.Unspecified, decl.type, source);
    return `export type ${name} = ${printed};`;
  }
  const type = checker.getDeclaredTypeOfSymbol(sym);
  const printed = checker.typeToString(type, decl, FLAGS);
  return `export type ${name} = ${printed};`;
};

// The named types reachable from HomesteadConfig that consumers may reference,
// plus the context types used by hook signatures. All are effect-free.
// Order matters: WorkItem + PrView before HomesteadContext; HomesteadContext
// before members that reference it; HomesteadEvent before HomesteadConfig.
const NAMED = [
  "WorkItem",
  "HomesteadContext",
  "PortSpec",
  "ServiceSpec",
  "SetupStep",
  "WorktreeContext",
  "AgentPromptContext",
  "TrackingContext",
  "PrPromptContext",
  "Plan",
  "EnvConfig",
  "AgentConfig",
  "IssuesConfig",
  "PrConfig",
  "LandConfig",
];

const blocks = [
  printInterface("WorkItem"),
  printExportedTypeAlias(prResolveEntry, "PrView"),
  // SurfaceCtx is a discriminated-union type alias referenced by AgentConfig's
  // surfaceLabel signature; emit it explicitly (printInterface would flatten the
  // union into a single interface and lose the discriminant narrowing).
  printExportedTypeAlias(typesEntry, "SurfaceCtx"),
  ...NAMED.filter((n) => n !== "WorkItem").map((n) => printInterface(n)),
  printExportedTypeAlias(eventsEntry, "HomesteadEvent"),
  printInterface("HomesteadConfig", { effectFreeHooks: true }),
];

const header = `// AUTO-GENERATED by homestead — do not edit.
// homestead-version: ${pkgVersion}
//
// Self-contained types for authoring a homestead.config.ts. No imports, no
// dependencies. Re-run \`homestead init\` after upgrading homestead to refresh.
//
// Usage in homestead.config.ts:
//   import type { HomesteadConfig } from "./homestead.config.types";
//   const config: HomesteadConfig = { /* ... */ };
//   export default config;
`;

const output = `${header}\n${blocks.join("\n\n")}\n`;

if (process.argv.includes("--check")) {
  // Compare structure only — the version stamp legitimately lags by one release
  // (release.sh re-stamps and amends after the version bump).
  const stripVersion = (s: string) => s.replace(/^\/\/ homestead-version: .*$/m, "");
  const current = (() => {
    try {
      return readFileSync(outPath, "utf8");
    } catch {
      return "";
    }
  })();
  if (stripVersion(current) !== stripVersion(output)) {
    console.error("homestead.config.types.d.ts is out of date — run: bun run scripts/gen-config-types.ts");
    process.exit(1);
  }
  console.log("homestead.config.types.d.ts is up to date");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath}`);
}
