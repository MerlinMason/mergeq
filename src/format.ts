import stringWidth from "string-width";
import type { Entry, Rate } from "./github.js";

export const DAY = 86_400_000;

export function ago(from: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "<1m";
  if (value < 60) return `${Math.round(value)}m`;
  const hours = Math.floor(value / 60);
  return `${hours}h${Math.round(value % 60)}m`;
}

export function lines(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

const BAR_WIDTH = 10;

export function bar(done: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.round((done / total) * BAR_WIDTH);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, BAR_WIDTH - filled));
}

function eta(position: number, rate: Rate | null, fallback: number | null): number | null {
  if (rate) return position * rate.gapMinutes;
  return fallback === null ? null : fallback / 60;
}

export function etaLabel(entry: Entry, rate: Rate | null): string {
  return `🔀 in ~${minutes(eta(entry.position, rate, entry.estimatedTimeToMerge))}`;
}

export const ETA_WIDTH = stringWidth("🔀 in ~") + 1 + stringWidth("10h30m");

export function waitColor(waited: number): string {
  if (waited > 3 * DAY) return "red";
  if (waited > DAY) return "yellow";
  return "gray";
}

export function busyness(depth: number): { emoji: string; label: string; color: string } {
  if (depth <= 1) return { emoji: "🧊", label: "chill", color: "cyan" };
  if (depth <= 4) return { emoji: "🍳", label: "warming up", color: "green" };
  if (depth <= 9) return { emoji: "🥵", label: "getting spicy", color: "yellow" };
  return { emoji: "🔥", label: "absolute carnage", color: "red" };
}

const REASONS: Record<string, { emoji: string; label: string }> = {
  merged: { emoji: "🔀", label: "shipped" },
  failed_checks: { emoji: "💥", label: "failed" },
  merge_conflict: { emoji: "🥊", label: "conflict" },
  manual: { emoji: "✋", label: "yanked" },
  queue_cleared: { emoji: "🧹", label: "cleared" },
  branch_protections: { emoji: "🚧", label: "blocked" },
  invalid_merge_commit: { emoji: "🫠", label: "bad commit" },
};

export function reasonOf(reason: string): { emoji: string; label: string } {
  return REASONS[reason] ?? { emoji: "😭", label: reason.replace(/_/g, " ") };
}

// Measured in terminal columns, not code units: an emoji is two columns wide and
// a variation selector adds units without adding width.
export const OUTCOME_WIDTH =
  stringWidth("🔀 ") +
  Math.max(...Object.values(REASONS).map((r) => stringWidth(r.label))) +
  stringWidth(" 10h ago");
