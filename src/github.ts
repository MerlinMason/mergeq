import { setTimeout as wait } from "node:timers/promises";
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
    id: string;
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
          pullRequest{ id number title author{ login } }
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

export type ReviewChecks = "passing" | "failing" | "running" | null;

export type Review = {
  number: number;
  title: string;
  author: string;
  additions: number;
  deletions: number;
  requestedAt: Date;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: ReviewChecks;
};

export type Own = {
  number: number;
  title: string;
  draft: boolean;
  updatedAt: Date;
  decision: Review["decision"];
  checks: ReviewChecks;
  reviewers: string[];
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

const OWN_FETCH_LIMIT = 20;

export async function fetchOwn(opts: {
  token: string;
  owner: string;
  name: string;
  login: string;
}): Promise<Own[]> {
  type Node = {
    number: number;
    title: string;
    isDraft: boolean;
    updatedAt: string;
    reviewDecision: Review["decision"];
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
    reviewRequests: {
      nodes: { requestedReviewer: { login?: string; slug?: string } | null }[];
    };
  };

  const data = await graphql<{ search: { nodes: Node[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:${OWN_FETCH_LIMIT}){ nodes{ ... on PullRequest {
      number title isDraft updatedAt reviewDecision
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      reviewRequests(first:5){ nodes{ requestedReviewer{
        ... on User { login } ... on Team { slug }
      }}}
    }}}}`,
    { q: `repo:${opts.owner}/${opts.name} is:pr is:open author:${opts.login} sort:updated-desc` },
  );

  return data.search.nodes
    .filter((node) => node?.number)
    .map((node) => ({
      number: node.number,
      title: node.title,
      draft: node.isDraft,
      updatedAt: new Date(node.updatedAt),
      decision: node.reviewDecision,
      checks: rollup(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
      reviewers: node.reviewRequests.nodes
        .map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.slug)
        .filter((who): who is string => Boolean(who)),
    }));
}

const REVIEW_FETCH_LIMIT = 25;

function rollup(state: string | null | undefined): ReviewChecks {
  if (!state) return null;
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "SUCCESS") return "passing";
  return "running";
}

export async function fetchReviews(opts: {
  token: string;
  owner: string;
  name: string;
  login: string;
  self: boolean;
}): Promise<Review[]> {
  type Requested = {
    createdAt: string;
    requestedReviewer: { __typename: string; login?: string } | null;
  };

  type Node = {
    number: number;
    title: string;
    createdAt: string;
    additions: number;
    deletions: number;
    author: { login: string } | null;
    reviewDecision: Review["decision"];
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
    requests: { nodes: Requested[] };
  };

  const data = await graphql<{ search: { nodes: Node[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:${REVIEW_FETCH_LIMIT}){ nodes{ ... on PullRequest {
      number title createdAt additions deletions
      author{ login }
      reviewDecision
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      requests: timelineItems(last:20, itemTypes:[REVIEW_REQUESTED_EVENT]){ nodes{ ... on ReviewRequestedEvent {
        createdAt requestedReviewer{ __typename ... on User { login } }
      }}}
    }}}}`,
    {
      q: [
        `repo:${opts.owner}/${opts.name}`,
        "is:pr is:open draft:false",
        // user-review-requested counts a request made to a team you are in;
        // review-requested does not, but is the only one that takes a name
        // other than your own.
        opts.self ? "user-review-requested:@me" : `review-requested:${opts.login}`,
        "sort:updated-desc",
      ].join(" "),
    },
  );

  return data.search.nodes
    .filter((node) => node?.number)
    .map((node) => {
      const events = node.requests.nodes.filter((event) => event?.createdAt);
      // Requests to a team carry the team, not you, so when nothing names you
      // the most recent request of any kind is the closest thing to a clock.
      const mine = events.filter((event) => event.requestedReviewer?.login === opts.login);
      const asked = (mine.length > 0 ? mine : events).at(-1);

      return {
        number: node.number,
        title: node.title,
        author: node.author?.login ?? "unknown",
        additions: node.additions,
        deletions: node.deletions,
        requestedAt: new Date(asked?.createdAt ?? node.createdAt),
        decision: node.reviewDecision,
        checks: rollup(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
      };
    })
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

// A gap longer than this means nobody was queueing, not that the queue was slow.
const IDLE_GAP_CEILING_MINUTES = 30;

const RATE_WINDOW_HOURS = 24;
const RATE_MIN_SAMPLE = 5;

export async function fetchRate(opts: {
  token: string;
  owner: string;
  name: string;
}): Promise<Rate | null> {
  const since = new Date(Date.now() - RATE_WINDOW_HOURS * 3600_000).toISOString().slice(0, 19) + "Z";

  const data = await graphql<{ search: { nodes: { mergedAt: string | null }[] } }>(
    opts.token,
    `query($q:String!){ search(query:$q, type:ISSUE, first:100){ nodes{ ... on PullRequest { mergedAt } } } }`,
    // sort:updated-desc sorts by when a pull request was last touched, not when
    // it merged. Without merged:>=, an old one with a recent comment lands in
    // the sample and stretches the window.
    { q: `repo:${opts.owner}/${opts.name} is:pr is:merged merged:>=${since} sort:updated-desc` },
  );

  const times = data.search.nodes
    .map((n) => (n.mergedAt ? new Date(n.mergedAt).getTime() : 0))
    .filter((t) => t > 0)
    .sort((a, b) => b - a);

  if (times.length < RATE_MIN_SAMPLE) return null;

  // GitHub merges in batches, so most gaps are the split second between two pull
  // requests landing together. A median picks one of those and promises a wait of
  // almost nothing.
  const ceiling = IDLE_GAP_CEILING_MINUTES * 60_000;
  let total = 0;
  for (let i = 1; i < times.length; i++) total += Math.min(times[i - 1]! - times[i]!, ceiling);

  const gapMinutes = total / (times.length - 1) / 60_000;
  if (gapMinutes <= 0) return null;

  return { gapMinutes };
}

export type Action = "eject" | "jump";

const DEQUEUE = `mutation($id:ID!){ dequeuePullRequest(input:{ id:$id }){ clientMutationId } }`;
const ENQUEUE_FRONT = `mutation($id:ID!){ enqueuePullRequest(input:{ pullRequestId:$id, jump:true }){ clientMutationId } }`;

const ALREADY_QUEUED = "already in the queue";
const REJOIN_ATTEMPTS = 5;
const REJOIN_WAIT_MS = 600;

// GitHub exposes no viewerCan* field for either of these, so whether you are
// allowed is only discoverable by asking. Ejecting needs write access; jumping
// is admin-only by default and undocumented, so the error is the interface.
export async function act(opts: {
  token: string;
  action: Action;
  pullRequestId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const id = opts.pullRequestId;

  if (opts.action === "eject") {
    await graphql(opts.token, DEQUEUE, { id });
    return;
  }

  // Jump is an option on joining the queue, not a way to move within it —
  // enqueuePullRequest refuses a pull request that is already there. So the entry
  // leaves and rejoins at the front, which is two mutations with a gap in the
  // middle where it belongs to neither.
  await graphql(opts.token, DEQUEUE, { id });

  for (let attempt = 1; attempt <= REJOIN_ATTEMPTS; attempt++) {
    try {
      await graphql(opts.token, ENQUEUE_FRONT, { id });
      return;
    } catch (caught) {
      const message = (caught as Error).message;

      // The dequeue is not always visible to the next call immediately. Waiting
      // on the signal means giving up if the dialog has since been dismissed,
      // rather than adding the pull request back after somebody cancelled.
      if (message.includes(ALREADY_QUEUED) && attempt < REJOIN_ATTEMPTS) {
        await wait(REJOIN_WAIT_MS, undefined, { signal: opts.signal });
        continue;
      }

      throw new Error(`It left the queue but could not rejoin at the front — ${message}`);
    }
  }
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
