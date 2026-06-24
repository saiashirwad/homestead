import { Effect, Schema } from "effect";
import { ExternalCommandError, IssueRepoMismatch } from "./errors.ts";
import { capture } from "./process.ts";
import { WorkItemSchema, type WorkItem } from "./work-item.ts";

export interface IssueRef {
  readonly number: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly ghArg: string;
}

const isUrlRef = (ref: IssueRef): ref is IssueRef & { owner: string; repo: string } =>
  ref.owner !== undefined && ref.repo !== undefined;

const ISSUE_URL = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;

export const parseIssueArg = (token: string): IssueRef | undefined => {
  if (/^\d+$/.test(token)) {
    return { number: Number(token), ghArg: token };
  }
  const match = ISSUE_URL.exec(token);
  if (match === null) return undefined;
  const [, owner, repo, n] = match;
  return { number: Number(n), owner, repo, ghArg: `https://github.com/${owner}/${repo}/issues/${n}` };
};

const RepoView = Schema.Struct({ nameWithOwner: Schema.String });

export const currentRepoSlug = Effect.fn("homestead/current-repo")(function* () {
  const json = yield* capture("gh", ["repo", "view", "--json", "nameWithOwner"]);
  const view = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RepoView))(json).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ExternalCommandError({ command: "gh repo view", detail: error.message }),
    ),
  );
  return view.nameWithOwner;
});

export const validateIssueRefs = Effect.fn("homestead/validate-issue-refs")(function* (
  refs: ReadonlyArray<IssueRef>,
) {
  const urlRefs = refs.filter(isUrlRef);
  if (urlRefs.length === 0) return;

  const here = (yield* currentRepoSlug()).toLowerCase();
  const bad = urlRefs.find((ref) => `${ref.owner}/${ref.repo}`.toLowerCase() !== here);
  if (bad !== undefined) {
    return yield* new IssueRepoMismatch({
      owner: bad.owner,
      repo: bad.repo,
      here,
    });
  }
});

export const resolveIssue = Effect.fn("homestead/resolve-issue")(function* (ref: IssueRef) {
  const json = yield* capture("gh", ["issue", "view", ref.ghArg, "--json", "number,url,title"]);
  const item: WorkItem = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItemSchema))(json).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ExternalCommandError({ command: "gh issue view", detail: error.message }),
    ),
  );
  return item;
});
