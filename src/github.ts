import { SetupError } from "./auth.js";

export type EntryState =
  | "QUEUED"
  | "AWAITING_CHECKS"
  | "MERGEABLE"
  | "UNMERGEABLE"
  | "LOCKED";

export type Entry = {
  position: number;
  state: EntryState;
  enqueuedAt: string;
  estimatedTimeToMerge: number | null;
  jump: boolean;
  solo: boolean;
  enqueuer: { login: string } | null;
  headCommit: { oid: string } | null;
  pullRequest: {
    number: number;
    title: string;
    author: { login: string } | null;
  };
};

export type Queue = {
  url: string;
  maximumEntriesToBuild: number | null;
  totalCount: number;
  entries: Entry[];
  viewer: string;
};

const QUERY = `
query($owner:String!,$name:String!,$branch:String!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    mergeQueue(branch:$branch){
      url
      configuration{ maximumEntriesToBuild }
      entries(first:50){
        totalCount
        nodes{
          position
          state
          enqueuedAt
          estimatedTimeToMerge
          jump
          solo
          enqueuer{ login }
          headCommit{ oid }
          pullRequest{ number title author{ login } }
        }
      }
    }
  }
}`;

type Response = {
  data?: {
    viewer: { login: string } | null;
    repository: {
      mergeQueue: {
        url: string;
        configuration: { maximumEntriesToBuild: number | null } | null;
        entries: { totalCount: number; nodes: (Entry | null)[] };
      } | null;
    } | null;
  };
  errors?: { message: string; type?: string }[];
};

export async function fetchQueue(opts: {
  token: string;
  owner: string;
  name: string;
  branch: string;
  signal?: AbortSignal;
}): Promise<Queue> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    signal: opts.signal,
    headers: {
      authorization: `bearer ${opts.token}`,
      "content-type": "application/json",
      "user-agent": "mergeq",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { owner: opts.owner, name: opts.name, branch: opts.branch },
    }),
  });

  if (res.status === 401) {
    throw new SetupError("GitHub rejected the token.", [
      "gh auth login",
      "gh auth status",
    ]);
  }

  if (res.status === 403) {
    const sso = res.headers.get("x-github-sso");
    throw new SetupError(
      sso
        ? "Token needs SSO authorisation for this organisation."
        : "GitHub returned 403 (rate limited, or missing scopes).",
      sso
        ? ["Authorise it at https://github.com/settings/tokens"]
        : ["gh auth refresh -h github.com -s repo"],
    );
  }

  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as Response;

  if (body.errors?.length) {
    const saml = body.errors.find((e) => e.type === "FORBIDDEN");
    throw new SetupError(
      body.errors.map((e) => e.message).join("; "),
      saml ? ["gh auth login", "then authorise SSO for the org"] : [],
    );
  }

  const repo = body.data?.repository;
  if (!repo) {
    throw new SetupError(
      `Cannot see ${opts.owner}/${opts.name} — it may be private or need SSO.`,
      ["gh auth refresh -h github.com -s repo"],
    );
  }

  const queue = repo.mergeQueue;
  if (!queue) {
    throw new SetupError(
      `No merge queue configured on ${opts.owner}/${opts.name}#${opts.branch}.`,
      ["Pass --branch <name> if the queue is on another branch"],
    );
  }

  return {
    url: queue.url,
    maximumEntriesToBuild: queue.configuration?.maximumEntriesToBuild ?? null,
    totalCount: queue.entries.totalCount,
    entries: queue.entries.nodes.filter((n): n is Entry => n !== null),
    viewer: body.data?.viewer?.login ?? "",
  };
}
