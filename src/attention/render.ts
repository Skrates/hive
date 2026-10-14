import type { Artifact, ItemView, QueuePage, Receipt, SourceView } from "./contract.js";

/**
 * Deterministic renderings (ADR-0004 §3). No model is involved: the brief is the submitting
 * seat's structured fields, laid out to fit one terminal screen. Every external string is
 * rendered inert — stored data is never altered, only its presentation.
 */

/** Display handle of an item. */
export function itemLabel(itemId: number): string {
  return `ATN-${itemId}`;
}

/**
 * Terminal-inert text: C0 controls (bar newline and tab), DEL, C1 controls and bidirectional
 * overrides are shown as `\u{…}` escapes, so a packet can neither move the cursor, recolour
 * the terminal, nor visually reorder what the operator reads.
 */
export function inert(text: string, keepNewlines = true): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const control = (code < 0x20 && !(keepNewlines && code === 0x0a) && code !== 0x09)
      || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
      || code === 0x200e || code === 0x200f || code === 0x061c;
    out += control ? `\\u{${code.toString(16)}}` : char;
  }
  return out;
}

/** Slack mrkdwn-inert text for the commons render: no mention, link or markup can be forged. */
export function slackInert(text: string): string {
  // Single-line: a newline in a scalar field could forge extra lines in the broker's post.
  return inert(text, false).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function ago(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** One inert line per artifact: every interpolated field, optional metadata included. */
export function artifactLine(artifact: Artifact): string {
  const version = artifact.version === undefined ? "" : ` @ ${artifact.version}`;
  // A local path is always shown with the edge that owns it; it is not a file on this machine.
  const edge = artifact.edge_id === undefined ? "" : ` [on edge ${artifact.edge_id}]`;
  return inert(`${artifact.label} — ${artifact.uri}${version}${edge}`, false);
}

export function returnDescription(source: SourceView | null, mode: ItemView["return_mode"]): string {
  if (source === null || mode === "none") return "none — resolving records the response; no agent is woken";
  if (mode === "pinned_session") {
    // The session id is the surface's own report, not a broker-shaped identifier.
    return inert(`originating seat ${source.actor}, saved session ${source.session_id ?? "?"} on ${source.edge_id}`, false);
  }
  return `originating seat ${source.actor}, context restored (not the original session or checkout)`;
}

/** The handoff brief: what to do, why, with what, what it unblocks, and where the answer goes. */
export function renderBrief(item: ItemView, now: Date, waitingBehind: number | null = null): string {
  const packet = item.packet;
  const lines = [
    `${itemLabel(item.item_id)} · ${inert(packet.project_id, false)} · ${inert(packet.title, false)}`,
    `[${packet.kind} · ${item.state} · revision ${item.revision} · work ${inert(packet.work_id, false)} / ${inert(packet.intervention_key, false)}]`,
    `Do: ${inert(packet.requested_action)}`,
    `Context: ${inert(packet.context)}`,
  ];
  if (packet.artifacts.length > 0) {
    lines.push("Open:");
    for (const artifact of packet.artifacts) lines.push(`  - ${artifactLine(artifact)}`);
  }
  const estimate = packet.estimate_minutes === null ? "" : ` Estimated human time: ${packet.estimate_minutes} minutes.`;
  const deadline = packet.deadline_at === null ? "" : ` Deadline: ${packet.deadline_at} (display only).`;
  lines.push(`Unblocks: ${inert(packet.unblocks)}${estimate}${deadline}`);
  // Creation age, named as such: a deferral that rejoined the tail was not queued all along.
  lines.push(`Return: ${returnDescription(item.source, item.return_mode)}; summoned ${ago(item.created_at, now)}.`);
  if (packet.predecessor_item_id !== null) lines.push(`Follows: ${itemLabel(packet.predecessor_item_id)}`);
  if (waitingBehind !== null) lines.push(`Queue: ${waitingBehind} more waiting (advisory; the queue moves).`);
  lines.push(`Resolve: hive attention resolve ${item.item_id} --expected-revision ${item.revision} --outcome <outcome> --response "<decision>" [--next]`);
  return lines.join("\n");
}

export function renderQueue(page: QueuePage, now: Date): string {
  const status = page.status;
  const head = [
    `Attention queue for ${status.human_id} as of ${page.as_of}`,
    status.active_item === null
      ? "Active: none"
      : `Active: ${itemLabel(status.active_item.item_id)} (revision ${status.active_item.revision})`,
    `Eligible: ${status.eligible_count} · Deferred: ${status.deferred_count}`
      + (status.next_deferred_at === null ? "" : ` (next due ${status.next_deferred_at})`)
      + (status.oldest_eligible_at === null ? "" : ` · oldest eligible ${ago(status.oldest_eligible_at, now)}`),
    `Returns: ${status.returns_pending} pending · ${status.returns_minted} in flight · ${status.returns_blocked} blocked · ${status.returns_failed} failed`,
  ];
  for (const warning of status.route_warnings) {
    head.push(`  ⚠ ${itemLabel(warning.item_id)} return generation ${warning.generation} ${warning.phase}: ${inert(warning.reason, false)}`);
  }
  const rows = page.items.map((item) => {
    const when = item.state === "deferred"
      ? (item.deferred_until === null ? "held indefinitely" : `until ${item.deferred_until}`)
      : ago(item.created_at, now);
    return `${itemLabel(item.item_id).padEnd(8)} ${item.state.padEnd(9)} r${String(item.revision).padEnd(3)} `
      + `${inert(item.packet.project_id, false)} · ${inert(item.packet.title, false)} (${item.packet.kind}, ${when})`;
  });
  const tail = page.next_cursor === null ? [] : [`More: --after ${page.next_cursor}`];
  return [...head, "", ...(rows.length > 0 ? rows : ["(no items)"]), ...tail].join("\n");
}

/** One human line per receipt, plus the selected brief when a selection rode along. */
export function renderReceipt(receipt: Receipt, now: Date): string {
  const lines: string[] = [];
  const item = receipt.item === null ? "" : ` ${itemLabel(receipt.item.item_id)} (revision ${receipt.item.revision}, ${receipt.item.state})`;
  lines.push(`${receipt.action}: ${receipt.result}${item}${receipt.replayed ? " [replayed — original committed result]" : ""}`);
  if (receipt.return_effect !== null) {
    lines.push(`Return: generation ${receipt.return_effect.generation} ${receipt.return_effect.phase} — response saved; the continuation is published independently.`);
  }
  if (receipt.source !== null) {
    lines.push(`Source: ${receipt.source.source_id} · ${receipt.source.actor} · ${receipt.source.return_mode}${receipt.source.revoked_at === null ? "" : " · revoked"}`);
  }
  const selection = receipt.selection;
  if (selection !== null) {
    if (selection.item === null) {
      const deferred = selection.deferred_count === 0
        ? "nothing deferred"
        : `${selection.deferred_count} deferred${selection.next_deferred_at === null ? " (held indefinitely)" : `, next due ${selection.next_deferred_at}`}`;
      lines.push(`Next: queue empty — ${deferred}. Nothing was invented and nothing is polling.`);
    } else {
      const lead = selection.selection_reason === "already_active"
        ? "Already active (finish, defer or cancel it to switch):"
        : `Next (${selection.selection_reason}):`;
      lines.push("", lead, selection.brief ?? renderBrief(selection.item, now));
    }
  }
  return lines.join("\n");
}
