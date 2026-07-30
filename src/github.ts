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

export type Checks = {
  total: number;
  done: number;
  failing: number;
  running: string | null;
};

export type Outcome = {
  number: number;
  title: string;
  kind: "merged" | "ejected";
  reason: string;
  at: Date;
  queuedMinutes: number | null;
};

export type Rate = {
  gapMinutes: number;
  spanHours: number;
  samples: number;
};

async function graphql<T>(token: string, query: string, variables: object): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "mergeq",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
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
  login: string;
}): Promise<Outcome[]> {
  type Node = {
    number: number;
    title: string;
    mergedAt: string | null;
    added: { nodes: { createdAt: string }[] };
    removed: { nodes: { createdAt: string; reason: string | null }[] };
  };

  const data = await graphql<{ search: { nodes: Node[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:25){ nodes{ ... on PullRequest {
      number title mergedAt
      added: timelineItems(last:5, itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT]){ nodes{ ... on AddedToMergeQueueEvent { createdAt } } }
      removed: timelineItems(last:5, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){ nodes{ ... on RemovedFromMergeQueueEvent { createdAt reason } } }
    }}}}`,
    {
      q: `repo:${opts.owner}/${opts.name} author:${opts.login} is:pr sort:updated-desc`,
    },
  );

  const outcomes: Outcome[] = [];

  for (const node of data.search.nodes) {
    for (const removal of node.removed.nodes) {
      const at = new Date(removal.createdAt);
      const merged = removal.reason === "merged";
      const priorAdd = node.added.nodes
        .map((a) => new Date(a.createdAt))
        .filter((a) => a.getTime() <= at.getTime())
        .pop();

      outcomes.push({
        number: node.number,
        title: node.title,
        kind: merged ? "merged" : "ejected",
        reason: (removal.reason ?? "removed").replace(/_/g, " "),
        at,
        queuedMinutes: priorAdd
          ? Math.max(0, Math.round((at.getTime() - priorAdd.getTime()) / 60000))
          : null,
      });
    }
  }

  return outcomes.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 12);
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

  const spanMs = times[0]! - times[times.length - 1]!;
  if (spanMs <= 0) return null;

  return {
    gapMinutes: spanMs / 60000 / times.length,
    spanHours: spanMs / 3600000,
    samples: times.length,
  };
}

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
