import { Console, Effect } from "effect";
import type { PrView } from "./pr/resolve.ts";
import type { HomesteadServices } from "./types.ts";
import type { WorkItem } from "./work-item.ts";

export type HomesteadEvent =
  | { type: "worktree.creating"; branch: string; targetDir: string; from?: string }
  | {
      type: "agent.launching" | "agent.launched";
      item: WorkItem;
      command: ReadonlyArray<string>;
      paneId?: string;
      worktreeDir: string;
    }
  | {
      type: "pr.launching" | "pr.launched";
      pr: PrView;
      mode: "review" | "work";
      branch: string;
      paneId?: string;
    }
  | { type: "issues.summary"; launched: number; total: number }
  | {
      type: "teardown";
      verb: "kill" | "close" | "complete";
      branch: string;
      phase: "start" | "done";
      reviewLabel?: string;
    };

const formatCommand = (command: ReadonlyArray<string>): string => command.join(" ");

export const formatEvent = (e: HomesteadEvent): string | undefined => {
  switch (e.type) {
    case "worktree.creating": {
      const fromSuffix = e.from === undefined ? "" : ` (from ${e.from})`;
      return `\n▸ Creating worktree '${e.branch}' at ${e.targetDir}${fromSuffix}`;
    }
    case "agent.launching":
      return `\n▸ Launching ${formatCommand(e.command)} for issue #${e.item.number} in ${e.worktreeDir}`;
    case "agent.launched":
      return `  ✓ #${e.item.number}: ${formatCommand(e.command)} launched in herdr pane ${e.paneId} — switch in to drive it`;
    case "pr.launching":
      return `\n▸ ${e.mode === "review" ? "Reviewing" : "Continuing"} PR #${e.pr.number}: ${e.pr.title}`;
    case "pr.launched":
      return (
        `  ✓ PR #${e.pr.number} ready on \`${e.branch}\` in herdr pane ${e.paneId} — switch in to drive it.\n` +
        `    Tear down with: homestead ${e.mode === "review" ? "kill" : "close"} ${e.branch}`
      );
    case "issues.summary":
      return e.launched === e.total
        ? `\n✅ ${e.launched} agent(s) launched. Switch into the issue-* workspaces to drive them.`
        : `\n✅ ${e.launched}/${e.total} agent(s) launched (${e.total - e.launched} skipped). Switch into the issue-* workspaces to drive them.`;
    case "teardown":
      if (e.phase === "start") {
        switch (e.verb) {
          case "kill":
            return `\n▸ Killing '${e.branch}'`;
          case "close":
            return `\n▸ Closing '${e.branch}'`;
          case "complete":
            return `\n▸ Completing '${e.branch}'`;
        }
      }
      switch (e.verb) {
        case "kill":
          return `  ✓ killed '${e.branch}'`;
        case "close":
          return `  ✓ closed '${e.branch}' (branch kept, issue → ${e.reviewLabel})`;
        case "complete":
          return `  ✓ completed '${e.branch}' (issue closed, branch removed)`;
      }
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
};

export const defaultReporter = (e: HomesteadEvent): Effect.Effect<void, never, HomesteadServices> => {
  const line = formatEvent(e);
  return line === undefined ? Effect.void : Console.log(line);
};

export const emit = (
  onEvent: ((e: HomesteadEvent) => Effect.Effect<void, never, HomesteadServices>) | undefined,
  e: HomesteadEvent,
): Effect.Effect<void, never, HomesteadServices> => (onEvent ?? defaultReporter)(e);
