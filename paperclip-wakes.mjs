// A wake Paperclip starts by itself for a Claude agent: a card given to it, a comment on its card, an answered
// question card, a recovery. Benny's rule (grill Q21): it waits for the agent's next turn in Claude Desktop, which
// sees it first; nothing starts on its own. So the run never starts Claude. It puts what changed in the agent's
// Desktop inbox (hooks/desktop-turn.mjs opens the next turn with it), and a card the wake is about that sits in todo
// or in_progress goes to backlog with a one-line note from the agent, so Paperclip neither retries the wake nor
// sweeps the card as stranded. A card a Desktop turn is working right now is left alone.
import fs from 'node:fs';
import path from 'node:path';

export const inboxFile = (instance, agentId) => path.join(instance, 'claude-desktop', 'inbox', `${agentId}.jsonl`);

/** Add one item to the agent's Desktop inbox. */
export function addToInbox(instance, agentId, item) {
  const file = inboxFile(instance, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
}

/** Items about the same card become one: the first reason, parked if any was, every comment once. */
function mergeByCard(items) {
  const out = [];
  const byCard = new Map();
  for (const item of items) {
    const id = item.card?.id;
    const same = id ? byCard.get(id) : null;
    if (!same) {
      const copy = { ...item, comments: [...(item.comments ?? [])] };
      out.push(copy);
      if (id) byCard.set(id, copy);
      continue;
    }
    same.parked = Boolean(same.parked || item.parked);
    for (const c of item.comments ?? []) if (!same.comments.some((x) => (x.id && x.id === c.id) || (!x.id && x.body === c.body))) same.comments.push(c);
  }
  return out;
}

/** Take everything in the agent's Desktop inbox (it is emptied), one item per card. */
export function takeInbox(instance, agentId) {
  const file = inboxFile(instance, agentId);
  const taking = `${file}.${process.pid}.${Date.now()}`;
  try { fs.renameSync(file, taking); } catch { return []; }
  const items = fs.readFileSync(taking, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  fs.rmSync(taking, { force: true });
  return mergeByCard(items);
}

const WHY = {
  issue_created: 'was made for you',
  issue_assigned: 'was given to you',
  issue_commented: 'has a new comment',
  issue_reopened_via_comment: 'was reopened with a comment',
  issue_blockers_resolved: 'is no longer blocked',
  issue_children_completed: 'had all its sub-cards finished',
  approval_approved: 'had its approval granted',
};

/** The inbox as the next turn reads it, or '' when it is empty. */
export function inboxText(items) {
  if (!items.length) return '';
  const lines = items.map((item) => {
    const card = item.card ? `${item.card.identifier ?? item.card.id}${item.card.title ? ` "${item.card.title}"` : ''}` : null;
    const what = card ? `${card} ${WHY[item.reason] ?? `woke you (${item.reason})`}` : `Paperclip woke you (${item.reason})`;
    const parked = item.parked ? ' (moved to backlog until you take it up)' : '';
    const said = (item.comments ?? []).map((c) => `\n  ${c.author ?? 'someone'}: ${String(c.body).replace(/\s+/g, ' ').trim()}`).join('');
    return `- ${what}${parked}.${said}`;
  });
  return `Since your last turn, in Paperclip:\n${lines.join('\n')}`;
}

async function call(api, pathname, { method = 'GET', token, runId, body } = {}) {
  try {
    const res = await fetch(`${String(api).replace(/\/+$/, '')}${pathname}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

const LIVE = new Set(['queued', 'running', 'scheduled_retry']);

/** Handle a wake Paperclip started by itself. Returns Paperclip's adapter result; never starts Claude. */
export async function absorbPaperclipWake(ctx, { instance, api }) {
  const wake = ctx.context?.paperclipWake && typeof ctx.context.paperclipWake === 'object' ? ctx.context.paperclipWake : {};
  const reason = ctx.context?.wakeReason ?? wake.reason ?? 'wake';
  const issueId = wake.issue?.id ?? ctx.context?.issueId ?? null;
  const name = ctx.agent?.name ?? 'The agent';
  let card = issueId ? { id: issueId, identifier: wake.issue?.identifier ?? null, title: wake.issue?.title ?? null } : null;
  let parked = false;

  if (issueId) {
    const current = await call(api, `/api/issues/${issueId}`, { token: ctx.authToken, runId: ctx.runId });
    if (current.status === 200 && current.json) {
      card = { id: issueId, identifier: current.json.identifier ?? card.identifier, title: current.json.title ?? card.title };
      const holder = current.json.checkoutRunId && current.json.checkoutRunId !== ctx.runId
        ? await call(api, `/api/heartbeat-runs/${current.json.checkoutRunId}`, { token: ctx.authToken, runId: ctx.runId })
        : null;
      const beingWorked = holder?.status === 200 && LIVE.has(holder.json?.status);
      if (['todo', 'in_progress'].includes(current.json.status) && !beingWorked) {
        const moved = await call(api, `/api/issues/${issueId}`, {
          method: 'PATCH', token: ctx.authToken, runId: ctx.runId,
          body: { status: 'backlog', comment: `Waiting for my next turn in Claude Desktop.` },
        });
        parked = moved.status >= 200 && moved.status < 300;
        if (!parked) await ctx.onLog('stderr', `[desktop] Could not move ${card.identifier ?? issueId} to backlog (${moved.status}): ${JSON.stringify(moved.json?.error ?? moved.json).slice(0, 300)}\n`);
      }
    }
  }

  const comments = (Array.isArray(wake.comments) ? wake.comments : []).slice(-5).map((c) => ({
    id: c.id, author: c.author?.name ?? c.authorName ?? c.author?.type ?? null, body: String(c.body ?? '').slice(0, 1500),
  }));
  addToInbox(instance, ctx.agent.id, { at: new Date().toISOString(), reason, runId: ctx.runId, card, parked, comments });
  const summary = `Waiting for ${name}'s next turn in Claude Desktop${card ? ` (${card.identifier ?? card.id}${parked ? ', moved to backlog' : ''})` : ''}.`;
  await ctx.onLog('stdout', `[desktop] ${summary}\n`);
  return {
    exitCode: 0, signal: null, timedOut: false, summary,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, provider: 'anthropic', billingType: 'subscription', costUsd: 0,
  };
}
