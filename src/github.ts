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
  estimatedTimeToMerge: number | null;
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

const QUEUE_PAGE = 100;

const QUERY = `
query($owner:String!,$name:String!,$branch:String!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    mergeQueue(branch:$branch){
      url
      configuration{ maximumEntriesToBuild }
      entries(first:${QUEUE_PAGE}){
        totalCount
        nodes{
          position
          state
          estimatedTimeToMerge
          headCommit{ oid }
          pullRequest{ number title author{ login } }
        }
      }
    }
  }
}`;

type QueueData = {
  viewer: { login: string } | null;
  repository: {
    mergeQueue: {
      url: string;
      configuration: { maximumEntriesToBuild: number | null } | null;
      entries: { totalCount: number; nodes: (Entry | null)[] };
    } | null;
  } | null;
};

export type Checks = {
  total: number;
  done: number;
  failing: number;
  running: string | null;
};

export type Outcome = {
  number: number;
  title: string;
  author: string;
  kind: "merged" | "ejected";
  reason: string;
  at: Date;
};

export type Rate = {
  gapMinutes: number;
};

const OUTCOME_FETCH_LIMIT = 12;

export function outcomeKey(outcome: Outcome): string {
  return `${outcome.number}-${outcome.at.getTime()}`;
}

function httpFailure(status: number, sso: boolean, statusText: string): Error {
  if (status === 401) {
    return new SetupError("GitHub rejected the token.", ["gh auth login", "gh auth status"]);
  }

  if (status === 403) {
    return sso
      ? new SetupError("Token needs SSO authorisation for this organisation.", [
          "Authorise it at https://github.com/settings/tokens",
        ])
      : new SetupError("GitHub returned 403 (rate limited, or missing scopes).", [
          "gh auth refresh -h github.com -s repo",
        ]);
  }

  return new Error(`GitHub returned ${status} ${statusText}`);
}

async function graphql<T>(
  token: string,
  query: string,
  variables: object,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "mergeq",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw httpFailure(res.status, Boolean(res.headers.get("x-github-sso")), res.statusText);
  }

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("GitHub returned no data");
  return body.data;
}

export async function fetchChecks(opts: {
  token: string;
  owner: string;
  name: string;
  oids: string[];
}): Promise<Map<string, Checks>> {
  const result = new Map<string, Checks>();
  if (opts.oids.length === 0) return result;

  const selections = opts.oids
    .map(
      (oid, index) => `c${index}: object(oid:"${oid}"){ ... on Commit {
        statusCheckRollup{ contexts(first:100){ totalCount nodes{
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        }}}
      }}`,
    )
    .join("\n");

  type Context =
    | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
    | { __typename: "StatusContext"; context: string; state: string };

  type Commit = {
    statusCheckRollup: { contexts: { totalCount: number; nodes: Context[] } } | null;
  } | null;

  const data = await graphql<{ repository: Record<string, Commit> }>(
    opts.token,
    `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ ${selections} } }`,
    { owner: opts.owner, name: opts.name },
  );

  opts.oids.forEach((oid, index) => {
    const commit = data.repository[`c${index}`];
    const contexts = commit?.statusCheckRollup?.contexts;
    if (!contexts) return;

    let done = 0;
    let failing = 0;
    let running: string | null = null;

    for (const context of contexts.nodes) {
      if (context.__typename === "CheckRun") {
        if (context.status === "COMPLETED") {
          done += 1;
          if (context.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion))
            failing += 1;
        } else if (!running) {
          running = context.name;
        }
      } else {
        if (context.state !== "PENDING") done += 1;
        else if (!running) running = context.context;
        if (context.state === "FAILURE" || context.state === "ERROR") failing += 1;
      }
    }

    result.set(oid, { total: contexts.totalCount, done, failing, running });
  });

  return result;
}

export async function fetchOutcomes(opts: {
  token: string;
  owner: string;
  name: string;
  login?: string;
}): Promise<Outcome[]> {
  type Node = {
    number: number;
    title: string;
    author: { login: string } | null;
    removed: { nodes: { createdAt: string; reason: string | null }[] };
  };

  const data = await graphql<{ search: { nodes: Node[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:50){ nodes{ ... on PullRequest {
      number title author{ login }
      removed: timelineItems(last:3, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){ nodes{ ... on RemovedFromMergeQueueEvent { createdAt reason } } }
    }}}}`,
    {
      q: [
        `repo:${opts.owner}/${opts.name}`,
        opts.login ? `author:${opts.login}` : "",
        "is:pr sort:updated-desc",
      ]
        .filter(Boolean)
        .join(" "),
    },
  );

  const outcomes: Outcome[] = [];

  for (const node of data.search.nodes) {
    for (const removal of node.removed.nodes) {
      outcomes.push({
        number: node.number,
        title: node.title,
        author: node.author?.login ?? "unknown",
        kind: removal.reason === "merged" ? "merged" : "ejected",
        reason: removal.reason ?? "removed",
        at: new Date(removal.createdAt),
      });
    }
  }

  return outcomes.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, OUTCOME_FETCH_LIMIT);
}

export async function fetchRate(opts: {
  token: string;
  owner: string;
  name: string;
}): Promise<Rate | null> {
  const data = await graphql<{ search: { nodes: { mergedAt: string | null }[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:50){ nodes{ ... on PullRequest { mergedAt } } } }`,
    { q: `repo:${opts.owner}/${opts.name} is:pr is:merged sort:updated-desc` },
  );

  const times = data.search.nodes
    .map((n) => (n.mergedAt ? new Date(n.mergedAt).getTime() : 0))
    .filter((t) => t > 0)
    .sort((a, b) => b - a);

  if (times.length < 5) return null;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i - 1]! - times[i]!);
  gaps.sort((a, b) => a - b);

  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median <= 0) return null;

  return { gapMinutes: median / 60000 };
}

export async function fetchQueue(opts: {
  token: string;
  owner: string;
  name: string;
  branch: string;
}): Promise<Queue> {
  const data = await graphql<QueueData>(opts.token, QUERY, {
    owner: opts.owner,
    name: opts.name,
    branch: opts.branch,
  });

  const repo = data.repository;
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
    viewer: data.viewer?.login ?? "",
  };
}
