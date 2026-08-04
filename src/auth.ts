import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class SetupError extends Error {
  constructor(
    message: string,
    readonly hint: string[],
  ) {
    super(message);
  }
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args);
    return stdout.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SetupError("The GitHub CLI (gh) is not installed.", [
        "brew install gh",
        "gh auth login",
      ]);
    }
    throw error;
  }
}

export async function resolveToken(): Promise<string> {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;

  const token = await gh(["auth", "token"]).catch(() => "");
  if (!token) {
    throw new SetupError("Not logged in to GitHub.", [
      "gh auth login",
      "gh auth status",
    ]);
  }
  return token;
}

type Repo = { owner: string; name: string; defaultBranch: string };

export async function resolveRepo(spec?: string): Promise<Repo> {
  const raw = await gh([
    "repo",
    "view",
    ...(spec ? [spec] : []),
    "--json",
    "nameWithOwner,defaultBranchRef",
    "--jq",
    '"\\(.nameWithOwner)\\t\\(.defaultBranchRef.name)"',
  ]).catch(() => "");

  const [nameWithOwner = "", branch = ""] = raw.split("\t");
  const [owner, name] = nameWithOwner.split("/");
  if (owner && name) return { owner, name, defaultBranch: branch || "main" };

  if (spec) {
    throw new SetupError(`Cannot see ${spec}.`, [
      "check the name, or that your token can read it",
      "gh auth refresh -h github.com -s repo",
    ]);
  }

  const inGitRepo = await run("git", ["rev-parse", "--is-inside-work-tree"])
    .then(() => true)
    .catch(() => false);

  throw new SetupError(
    inGitRepo ? "This git repository has no GitHub remote." : "Not inside a git repository.",
    ["mergeq --repo owner/name", "or export MERGEQ_REPO=owner/name to set a default"],
  );
}
