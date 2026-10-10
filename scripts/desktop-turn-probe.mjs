#!/usr/bin/env node
// Live check of Desktop turns as Paperclip runs, against the running Paperclip, with no model calls: throwaway agents
// in a test org take pretend Desktop turns (hand-written transcripts) through the real org-folder hooks and the real
// adapter. It checks what the design leans on (PAPERCLIP-WORKFLOWS.md, "What this means"):
//   1. a turn's hook gets a run id at once, and the adapter sees the Desktop-turn reason;
//   2. a backlog card assigned to the agent wakes nothing;
//   3. a turn whose message names a card runs on it: the agent's lasting key plus the run id checks it out,
//      comments, and closes it;
//   4. the run carries the turn: its log, its tokens as subscription use, and it ends at Stop;
//   5. a plain turn moves to a card partway (paperclip-card) and can then write on it;
//   6. two turns back to back get two runs;
//   7. an agent with no Paperclip AI connection still gets its turns recorded.
// Then it terminates the agents (their keys go with them) and removes their files. The org must be active.
//   node scripts/desktop-turn-probe.mjs --org <company id> [--api http://127.0.0.1:3100]
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFile } from '../paperclip-access.mjs';
import { turnsDir } from '../desktop-turn.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const API = arg('api', 'http://127.0.0.1:3100');
const ORG = arg('org');
const INSTANCE = arg('instance', path.join(os.homedir(), '.paperclip', 'instances', 'default'));
const HOOK = fileURLToPath(new URL('../hooks/desktop-turn.mjs', import.meta.url));
const CARD_TOOL = fileURLToPath(new URL('../hooks/paperclip-card.mjs', import.meta.url));
if (!ORG) { console.error('--org <company id> is required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(pathname, { method = 'GET', body, token, runId } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const list = (x) => (Array.isArray(x) ? x : x?.items ?? x?.runs ?? x?.data ?? []);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`); };
const exec = (script, args, { stdin, env = {} } = {}) => new Promise((resolve) => {
  const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, PAPERCLIP_RUN_ID: '', ...env } }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }));
  child.stdin.end(stdin === undefined ? '' : JSON.stringify(stdin));
});
const hook = (input) => exec(HOOK, ['--api', API, '--instance', INSTANCE], { stdin: input }).then((r) => r.stdout);
const runIdIn = (text) => String(text).match(/run ([0-9a-f]{8}-[0-9a-f-]{27})/)?.[1] ?? null;
async function runOf(id, until, ms = 30_000) {
  for (const end = Date.now() + ms; ; await sleep(300)) {
    const r = await call(`/api/heartbeat-runs/${id}`);
    if (until(r.json) || Date.now() > end) return r.json;
  }
}
const finished = (r) => ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(r?.status);
const say = (transcript, sessionId, id, text, usage = { input_tokens: 1, output_tokens: 1 }) => fs.appendFileSync(transcript, `${JSON.stringify({
  type: 'assistant', uuid: crypto.randomUUID(), sessionId, message: { id, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage },
})}\n`);

const company = (await call(`/api/companies/${ORG}`)).json;
if (company?.status !== 'active') { console.error(`Org ${ORG} is ${company?.status ?? 'missing'}; it must be active.`); process.exit(2); }
const connection = list((await call(`/api/companies/${ORG}/agents`)).json).find((a) => a.runtimeConfig?.aiConnection)?.runtimeConfig.aiConnection;

const tag = crypto.randomUUID().slice(0, 8);
const made = [];
const folders = [];
const sessions = [];
async function probeAgent(name, { withConnection }) {
  const agent = (await call(`/api/companies/${ORG}/agents`, {
    method: 'POST',
    body: {
      name, role: 'general', adapterType: 'claude_local', adapterConfig: { model: 'haiku' },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true }, ...(withConnection && connection ? { aiConnection: connection } : {}) },
    },
  })).json;
  if (agent?.id) made.push(agent);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-turn-probe-'));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.claude', 'agents', 'probe.md'), `---\nname: probe\npaperclip-agent-id: ${agent?.id}\n---\nA probe.\n`);
  const sessionId = crypto.randomUUID();
  sessions.push(sessionId);
  const transcript = path.join(folder, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'agent-setting', agentSetting: 'probe', sessionId })}\n`);
  const turn = (prompt) => ({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: transcript, cwd: folder, prompt });
  return { agent, folder, sessionId, transcript, turn, stop: () => hook({ ...turn(''), hook_event_name: 'Stop' }) };
}

try {
  const p = await probeAgent('Desktop turn probe', { withConnection: true });
  check('throwaway agent made', p.agent?.id, p.agent?.status ?? p.agent?.error);
  if (!p.agent?.id) throw new Error('no agent');

  // 2. A backlog card for the agent wakes nothing (and is the card the next turn names).
  const card = (await call(`/api/companies/${ORG}/issues`, { method: 'POST', body: { title: `Desktop turn probe card ${tag}`, status: 'backlog', assigneeAgentId: p.agent.id } })).json;
  await sleep(3000);
  const runsSoFar = list((await call(`/api/companies/${ORG}/heartbeat-runs?agentId=${p.agent.id}`)).json).filter((r) => r.agentId === p.agent.id).length;
  check('a backlog assignment wakes nothing', card?.id && runsSoFar === 0, { card: card?.identifier, runs: runsSoFar });

  // 1 + 3. A turn that names the card runs on it.
  const runId = runIdIn(await hook(p.turn(`<cross-session-message from-name="Chief of Staff">Please take ${card.identifier}</cross-session-message>`)));
  check('the hook got a run id at once', runId, runId);
  if (!runId) throw new Error('no run');
  const running = await runOf(runId, (r) => r?.status === 'running');
  check('the run is running, woken as a Desktop turn, on the named card', running?.status === 'running' && running?.contextSnapshot?.wakeReason === 'desktop_turn' && running?.contextSnapshot?.issueId === card.id,
    { status: running?.status, wakeReason: running?.contextSnapshot?.wakeReason, issueId: running?.contextSnapshot?.issueId });
  const token = JSON.parse(fs.readFileSync(keyFile(INSTANCE, p.agent.id), 'utf8')).token;
  const out = await call(`/api/issues/${card.id}/checkout`, { method: 'POST', token, runId, body: { agentId: p.agent.id, expectedStatuses: ['backlog', 'todo'] } });
  check('checkout with the lasting key + run id', out.status < 300, { http: out.status, error: out.json?.error });
  const comment = await call(`/api/issues/${card.id}/comments`, { method: 'POST', token, runId, body: { body: 'Probe: written from a Desktop turn.' } });
  check('comment on its card', comment.status < 300, { http: comment.status, error: comment.json?.error?.slice?.(0, 120) });
  say(p.transcript, p.sessionId, 'msg_probe_1', 'Probe done.', { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56 });
  const closed = await call(`/api/issues/${card.id}`, { method: 'PATCH', token, runId, body: { status: 'done', comment: 'Probe card closed from the Desktop turn.' } });
  check('close its card', closed.status < 300, { http: closed.status, error: closed.json?.error?.slice?.(0, 120) });
  await p.stop();

  // 4. The run carries the turn.
  const ended = await runOf(runId, finished);
  check('Stop ends the run, succeeded', ended?.status === 'succeeded', { status: ended?.status, error: ended?.error ?? ended?.errorMessage });
  const usage = ended?.usageJson ?? ended?.usage ?? {};
  check("the run has the turn's tokens, as subscription use", usage.outputTokens === 34 && usage.billingType === 'subscription_included', { outputTokens: usage.outputTokens, billingType: usage.billingType, costUsd: usage.costUsd });
  const log = await fetch(`${API}/api/heartbeat-runs/${runId}/log`).then((r) => r.text()).catch(() => '');
  check("the run's log has the turn", log.includes('Probe done.'), `${log.length} bytes`);
  const cardRuns = list((await call(`/api/issues/${card.id}/runs`)).json);
  check('the card lists the run', cardRuns.some((r) => (r.id ?? r.runId) === runId));

  // 5. A plain turn moves to a card partway.
  const card2 = (await call(`/api/companies/${ORG}/issues`, { method: 'POST', body: { title: `Desktop turn probe card 2 ${tag}`, status: 'backlog', assigneeAgentId: p.agent.id } })).json;
  const plain = runIdIn(await hook(p.turn('How is the stand doing?')));
  const plainRun = await runOf(plain, (r) => r?.status === 'running');
  check('a plain turn runs with no card', plainRun?.status === 'running' && !plainRun?.contextSnapshot?.issueId, { status: plainRun?.status, issueId: plainRun?.contextSnapshot?.issueId ?? null });
  const env = {
    PAPERCLIP_API_URL: API, PAPERCLIP_API_KEY: token, PAPERCLIP_AGENT_ID: p.agent.id, PAPERCLIP_INSTANCE_ROOT: INSTANCE,
    CLAUDE_DESKTOP_SESSION_ID: p.sessionId, CLAUDE_DESKTOP_TRANSCRIPT: p.transcript,
  };
  const moved = await exec(CARD_TOOL, [card2.identifier], { env });
  const cardRun = runIdIn(moved.stdout);
  check('paperclip-card moves the rest of the turn to the card', moved.code === 0 && cardRun && cardRun !== plain, moved.stdout.trim() || moved.stderr.trim());
  const plainEnded = await runOf(plain, finished);
  check('the run so far ends at the move', plainEnded?.status === 'succeeded', plainEnded?.status);
  await runOf(cardRun, (r) => r?.status === 'running');
  const c2 = await call(`/api/issues/${card2.id}/comments`, { method: 'POST', token, runId: cardRun, body: { body: 'Probe: written after moving to the card.' } });
  check('comment after the move', c2.status < 300, { http: c2.status, error: c2.json?.error?.slice?.(0, 120) });
  await call(`/api/issues/${card2.id}`, { method: 'PATCH', token, runId: cardRun, body: { status: 'done' } });
  say(p.transcript, p.sessionId, 'msg_probe_2', 'Moved and done.');
  await p.stop();
  check('the card run ends at Stop', (await runOf(cardRun, finished))?.status === 'succeeded');

  // 6. Two turns back to back.
  const a = runIdIn(await hook(p.turn('turn A')));
  say(p.transcript, p.sessionId, 'msg_a', 'A');
  await p.stop();
  const b = runIdIn(await hook(p.turn('turn B')));
  say(p.transcript, p.sessionId, 'msg_b', 'B');
  await p.stop();
  const [ra, rb] = [await runOf(a, finished), await runOf(b, finished)];
  check('back-to-back turns get two runs, both succeed', a && b && a !== b && ra?.status === 'succeeded' && rb?.status === 'succeeded', { a, b, statusA: ra?.status, statusB: rb?.status });

  // 7. No Paperclip AI connection.
  const q = await probeAgent('Desktop turn probe (no connection)', { withConnection: false });
  check('agent with no AI connection made', q.agent?.id, q.agent?.status ?? q.agent?.error);
  const qRun = runIdIn(await hook(q.turn('Hello')));
  say(q.transcript, q.sessionId, 'msg_q', 'Hi.');
  await q.stop();
  const qEnded = qRun ? await runOf(qRun, finished) : null;
  check('its turn is recorded too', qEnded?.status === 'succeeded', { run: qRun, status: qEnded?.status, error: qEnded?.error ?? qEnded?.errorCode });
} catch (error) {
  check('probe finished', false, error.message);
} finally {
  for (const agent of made) {
    const t = await call(`/api/agents/${agent.id}/terminate`, { method: 'POST', body: {} });
    console.log(`cleanup: ${agent.name} terminated (${t.status})`);
    fs.rmSync(keyFile(INSTANCE, agent.id), { force: true });
  }
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  for (const f of fs.existsSync(turnsDir(INSTANCE)) ? fs.readdirSync(turnsDir(INSTANCE)) : []) {
    const file = path.join(turnsDir(INSTANCE), f);
    try { if (sessions.some((s) => f.startsWith(`session-${s}.`) || fs.readFileSync(file, 'utf8').includes(s))) fs.rmSync(file, { force: true }); } catch { /* gone */ }
  }
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
