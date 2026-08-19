import { formatStatus, type ActivityEvent } from "@/lib/ui/api-client";

/**
 * Turn one activity row into a readable sentence.
 *
 * Presentation only, and deliberately deterministic: the activity feed is an
 * audit surface, so the same event must always read the same way. Unknown
 * actions fall through to `actor · action` rather than being dropped, so a new
 * event type is visible in the feed before anyone writes a phrase for it.
 */
export function humanizeActivity(event: ActivityEvent) {
  const actor = event.actor?.name ?? "Someone";
  const metadata = event.metadata ?? {};

  switch (event.action) {
    case "task.created":
      return `${actor} created this task`;
    case "task.status_changed":
      return `${actor} moved status ${formatStatus(String(metadata.fromStatus ?? "?"))} → ${formatStatus(String(metadata.toStatus ?? "?"))}`;
    case "task.updated": {
      const fields = typeof metadata.changedFields === "string" ? metadata.changedFields : "";
      return fields ? `${actor} updated ${fields}` : `${actor} updated this task`;
    }
    case "dependency.created":
      return `${actor} added a ${formatStatus(String(metadata.type ?? "BLOCKS"))} dependency`;
    default:
      return `${actor} · ${event.action}`;
  }
}
