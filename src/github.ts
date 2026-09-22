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

type ReviewChecks = "passing" | "failing" | "running" | null;

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

export type Pr = {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  updatedAt: Date;
  decision: Review["decision"];
  checks: ReviewChecks;
  reviewers: string[];
};

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

// One reply can carry both data and the reasons part of it is missing. Only
// the dashboard has any use for a half answer; everything else wants `graphql`.
async function request<T>(
  token: string,
  query: string,
  variables: object,
): Promise<{ data: T | null; errors: string[] }> {
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

  const body = (await res.json()) as { data?: T | null; errors?: { message: string }[] };
  return { data: body.data ?? null, errors: (body.errors ?? []).map((error) => error.message) };
}

async function graphql<T>(token: string, query: string, variables: object): Promise<T> {
  const { data, errors } = await request<T>(token, query, variables);
  if (errors.length) throw new Error(errors.join("; "));
  if (!data) throw new Error("GitHub returned no data");
  return data;
}

const QUEUE_PAGE = 100;
export const PR_FETCH_LIMIT = 20;
const REVIEW_FETCH_LIMIT = 25;
const OUTCOME_SEARCH = 50;
const OUTCOME_LIMIT = 12;
const RATE_SAMPLE = 100;

const ROLLUP = "commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }";

// One document for every panel, so they cannot describe different instants.
// GitHub prices a query by the nodes it asks for rather than by how many fields
// ask, so all of this costs the one point the cheapest of them cost alone.
const DASHBOARD = `
query($owner:String!,$name:String!,$branch:String!,$reviews:String!,$prs:String!,$outcomes:String!,$rate:String!){
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
  reviews: search(query:$reviews, type:ISSUE, first:${REVIEW_FETCH_LIMIT}){ nodes{ ... on PullRequest {
    number title createdAt additions deletions reviewDecision
    author{ login }
    ${ROLLUP}
    requests: timelineItems(last:20, itemTypes:[REVIEW_REQUESTED_EVENT]){ nodes{ ... on ReviewRequestedEvent {
      createdAt requestedReviewer{ __typename ... on User { login } }
    }}}
  }}}
  prs: search(query:$prs, type:ISSUE, first:${PR_FETCH_LIMIT}){ nodes{ ... on PullRequest {
    number title isDraft updatedAt reviewDecision
    author{ login }
    ${ROLLUP}
    reviewRequests(first:5){ nodes{ requestedReviewer{
      ... on User { login } ... on Team { slug }
    }}}
  }}}
  outcomes: search(query:$outcomes, type:ISSUE, first:${OUTCOME_SEARCH}){ nodes{ ... on PullRequest {
    number title
    author{ login }
    removed: timelineItems(last:3, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){ nodes{ ... on RemovedFromMergeQueueEvent {
      createdAt reason
    }}}
  }}}
  rate: search(query:$rate, type:ISSUE, first:${RATE_SAMPLE}){ nodes{ ... on PullRequest { number mergedAt } } }
}`;

type RollupNode = { commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };

type ReviewNode = RollupNode & {
  number: number;
  title: string;
  createdAt: string;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  reviewDecision: Review["decision"];
  requests: {
    nodes: { createdAt: string; requestedReviewer: { __typename: string; login?: string } | null }[];
  };
};

type PrNode = RollupNode & {
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string } | null;
  reviewDecision: Review["decision"];
  reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] };
};

type OutcomeNode = {
  number: number;
  title: string;
  author: { login: string } | null;
  removed: { nodes: { createdAt: string; reason: string | null }[] };
};

type MergedNode = { number: number; mergedAt: string | null };

type Search<T> = { nodes: (T | null)[] } | null;

type DashboardData = {
  viewer: { login: string } | null;
  repository: {
    mergeQueue: {
      url: string;
      configuration: { maximumEntriesToBuild: number | null } | null;
      entries: { totalCount: number; nodes: (Entry | null)[] };
    } | null;
  } | null;
  reviews: Search<ReviewNode>;
  prs: Search<PrNode>;
  outcomes: Search<OutcomeNode>;
  rate: Search<MergedNode>;
};

export type Section = "queue" | "reviews" | "prs" | "outcomes" | "rate";

/**
 * A section GitHub did not answer for is null and named in `missing` — which
 * means unanswered, not empty, so the caller can keep what it had.
 */
export type Snapshot = {
  at: Date;
  viewer: string;
  queue: Queue | null;
  reviews: Review[] | null;
  prs: Pr[] | null;
  outcomes: Outcome[] | null;
  rate: Rate | null;
  missing: Section[];
};

function rollup(node: RollupNode): ReviewChecks {
  const state = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (!state) return null;
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "SUCCESS") return "passing";
  return "running";
}

// A type:ISSUE search can return something that is not a pull request, and the
// inline fragment then yields an empty object rather than nothing at all.
function rows<T extends { number: number }>(search: Search<T>): T[] | null {
  if (!search) return null;
  return search.nodes.filter((node): node is T => Boolean(node?.number));
}

function terms(...parts: (string | false)[]): string {
  return parts.filter(Boolean).join(" ");
}

function toReviews(nodes: ReviewNode[], login: string): Review[] {
  return nodes
    .map((node) => {
      const events = node.requests.nodes.filter((event) => event?.createdAt);
      // Requests to a team carry the team, not you, so when nothing names you
      // the most recent request of any kind is the closest thing to a clock.
      const mine = events.filter((event) => event.requestedReviewer?.login === login);
      const asked = (mine.length > 0 ? mine : events).at(-1);

      return {
        number: node.number,
        title: node.title,
        author: node.author?.login ?? "unknown",
        additions: node.additions,
        deletions: node.deletions,
        requestedAt: new Date(asked?.createdAt ?? node.createdAt),
        decision: node.reviewDecision,
        checks: rollup(node),
      };
    })
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

function toPrs(nodes: PrNode[]): Pr[] {
  return nodes.map((node) => ({
    number: node.number,
    title: node.title,
    author: node.author?.login ?? "unknown",
    draft: node.isDraft,
    updatedAt: new Date(node.updatedAt),
    decision: node.reviewDecision,
    checks: rollup(node),
    reviewers: node.reviewRequests.nodes
      .map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.slug)
      .filter((who): who is string => Boolean(who)),
  }));
}

function toOutcomes(nodes: OutcomeNode[]): Outcome[] {
  const outcomes: Outcome[] = [];

  for (const node of nodes) {
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

  return outcomes.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, OUTCOME_LIMIT);
}

// A gap longer than this means nobody was queueing, not that the queue was slow.
const IDLE_GAP_CEILING_MINUTES = 30;

const RATE_WINDOW_HOURS = 24;
const RATE_MIN_SAMPLE = 5;

function toRate(nodes: MergedNode[]): Rate | null {
  const times = nodes
    .map((node) => (node.mergedAt ? new Date(node.mergedAt).getTime() : 0))
    .filter((time) => time > 0)
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

export async function fetchDashboard(opts: {
  token: string;
  owner: string;
  name: string;
  branch: string;
  as?: string;
  mine: boolean;
}): Promise<Snapshot> {
  const repo = `repo:${opts.owner}/${opts.name}`;
  // `@me` saves a round trip: otherwise the searches wait for the login this
  // same query is fetching. Only --as has to name somebody.
  const author = opts.mine && `author:${opts.as ?? "@me"}`;
  const since = new Date(Date.now() - RATE_WINDOW_HOURS * 3600_000).toISOString().slice(0, 19) + "Z";

  const { data, errors } = await request<DashboardData>(opts.token, DASHBOARD, {
    owner: opts.owner,
    name: opts.name,
    branch: opts.branch,
    reviews: terms(
      repo,
      "is:pr is:open draft:false",
      // user-review-requested counts a request made to a team you are in;
      // review-requested does not, but is the only one that takes a name
      // other than your own.
      opts.as ? `review-requested:${opts.as}` : "user-review-requested:@me",
      "sort:updated-desc",
    ),
    prs: terms(repo, "is:pr is:open", author, "sort:updated-desc"),
    outcomes: terms(repo, "is:pr", author, "sort:updated-desc"),
    // sort:updated-desc sorts by when a pull request was last touched, not when
    // it merged. Without merged:>=, an old one with a recent comment lands in
    // the sample and stretches the window.
    rate: terms(repo, "is:pr is:merged", `merged:>=${since}`, "sort:updated-desc"),
  });

  if (!data) throw new Error(errors[0] ?? "GitHub returned no data");

  // A null alongside errors is GitHub failing to answer, and the caller keeps
  // what it had. The same null in a clean reply means the thing is not there.
  const broken = errors.length > 0;

  if (!data.repository && !broken) {
    throw new SetupError(`Cannot see ${opts.owner}/${opts.name} — it may be private or need SSO.`, [
      "gh auth refresh -h github.com -s repo",
    ]);
  }

  if (data.repository && !data.repository.mergeQueue && !broken) {
    throw new SetupError(`No merge queue configured on ${opts.owner}/${opts.name}#${opts.branch}.`, [
      "Pass --branch <name> if the queue is on another branch",
    ]);
  }

  const merging = data.repository?.mergeQueue ?? null;
  const viewer = opts.as ?? data.viewer?.login ?? "";
  const reviews = rows(data.reviews);
  const prs = rows(data.prs);
  const outcomes = rows(data.outcomes);
  const merged = rows(data.rate);

  const sections: [Section, unknown][] = [
    ["queue", merging],
    ["reviews", reviews],
    ["prs", prs],
    ["outcomes", outcomes],
    ["rate", merged],
  ];

  return {
    at: new Date(),
    viewer,
    queue: merging && {
      url: merging.url,
      maximumEntriesToBuild: merging.configuration?.maximumEntriesToBuild ?? null,
      totalCount: merging.entries.totalCount,
      entries: merging.entries.nodes.filter((node): node is Entry => node !== null),
    },
    reviews: reviews && toReviews(reviews, viewer),
    prs: prs && toPrs(prs),
    outcomes: outcomes && toOutcomes(outcomes),
    rate: merged && toRate(merged),
    missing: sections.filter(([, value]) => !value).map(([section]) => section),
  };
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
