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

export async function resolveRepo(): Promise<{ owner: string; name: string }> {
  const raw = await gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).catch(() => "");

  const [owner, name] = raw.split("/");
  if (!owner || !name) {
    throw new SetupError("Not inside a GitHub repository.", [
      "cd into a repo, or pass --repo owner/name",
    ]);
  }
  return { owner, name };
}

export async function resolveDefaultBranch(
  owner: string,
  name: string,
): Promise<string> {
  const branch = await gh([
    "repo",
    "view",
    `${owner}/${name}`,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]).catch(() => "");
  return branch || "main";
}
