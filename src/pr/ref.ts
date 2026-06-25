export interface PrRef {
  readonly number: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly ghArg: string;
}

const PR_URL = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

export const parsePrArg = (token: string): PrRef | undefined => {
  if (/^\d+$/.test(token)) {
    return { number: Number(token), ghArg: token };
  }
  const match = PR_URL.exec(token);
  if (match === null) return undefined;
  const [, owner, repo, n] = match;
  return { number: Number(n), owner, repo, ghArg: `https://github.com/${owner}/${repo}/pull/${n}` };
};
