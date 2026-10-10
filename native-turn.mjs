// A Paperclip run as a native Claude Code turn:
// - the agent is a Claude Code custom agent (.claude/agents/<agent>.md in the run folder, or --agents for a git
//   repo), holding its Paperclip instructions and Paperclip's standing rules once, as its system prompt;
// - each card is one conversation that continues with --resume;
// - the message is what the person wrote on the card, word for word;
// - Paperclip's details for the turn (the card, what changed, what the wake needs) reach Claude as hook
//   context, which Claude Code keeps beside the message instead of in it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOOK_SCRIPT = fileURLToPath(new URL('./hooks/turn-context.mjs', import.meta.url));

// The prompt Paperclip's adapter sends: only the turn's message (see nativeContext).
export const NATIVE_MESSAGE_TEMPLATE = '{{context.paperclipNativeMessage}}';

const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/**
 * Where Claude Code keeps a folder's conversations: <config>/projects/<folder, every other character as ->.
 * Claude Code shortens names past 200 characters and adds a hash, so a long one is found by its first 200.
 */
export function projectDir(cwd, configDir = claudeConfigDir()) {
  const name = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projects = path.join(configDir, 'projects');
  if (name.length <= 200) return path.join(projects, name);
  const match = fs.existsSync(projects) && fs.readdirSync(projects).find((d) => d.startsWith(name.slice(0, 200)));
  return path.join(projects, match || name);
}

/** True when this folder has that conversation, so --resume can continue it. */
export function hasConversation(cwd, sessionId, configDir) {
  return UUID.test(String(sessionId ?? '')) && fs.existsSync(path.join(projectDir(cwd, configDir), `${sessionId}.jsonl`));
}

/** The folder Paperclip's Claude adapter runs in, by its own rule: the run's folder, or the agent's cwd over its home. */
export function claudeRunCwd(context, config) {
  const ws = context?.paperclipWorkspace && typeof context.paperclipWorkspace === 'object' ? context.paperclipWorkspace : {};
  const own = typeof config?.cwd === 'string' ? config.cwd : '';
  const workspaceCwd = ws.source === 'agent_home' && own ? '' : (typeof ws.cwd === 'string' ? ws.cwd : '');
  return workspaceCwd || own || process.cwd();
}

/**
 * Continue the card's conversation whenever Claude Code has it in this folder. Paperclip's own adapter also
 * requires the same instructions fingerprint, and Paperclip moves each run's instructions copy, so it started a
 * new conversation every run. Returns the session state to hand Paperclip's adapter: the conversation without
 * the fingerprints, or none at all.
 */
export function conversationFor(runtime, cwd, configDir) {
  const params = runtime?.sessionParams && typeof runtime.sessionParams === 'object' ? runtime.sessionParams : {};
  const id = params.sessionId ?? runtime?.sessionId ?? null;
  const saved = typeof params.cwd === 'string' && params.cwd ? params.cwd : cwd;
  if (id && path.resolve(saved) === path.resolve(cwd) && hasConversation(cwd, id, configDir)) {
    const { promptBundleKey: _bundle, mcpServerIdentity: _mcp, ...rest } = params;
    return { resume: id, runtime: { ...runtime, sessionId: id, sessionParams: { ...rest, sessionId: id, cwd } } };
  }
  return { resume: null, runtime: { ...runtime, sessionId: null, sessionParams: null } };
}

/** A Claude Code agent name from a Paperclip agent name ("Chief of Staff" -> "chief-of-staff"). */
export function agentSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agent';
}

export const PAPERCLIP_NOTES = (name) => `## Working through Paperclip

You are ${name}, an agent in a Paperclip org, working as a Claude Code session in the folder Paperclip gives the card.
- Every Paperclip card you work on is its own conversation here, named "<card> · ${name}". Its messages are the board's own words from the card, or the card itself when it is new. Paperclip's details for each turn (the card, what changed, what the wake needs) arrive with the message as context: follow them.
- While Claude Desktop has the conversation open, Paperclip's turn arrives there as a message from another session named Paperclip: the board's words, then Paperclip's details and the run id to send as X-Paperclip-Run-Id. Treat it as the card's next message.
- Your agent folder is $AGENT_HOME: relative file references in your instructions (./HEARTBEAT.md, ./SOUL.md, ./TOOLS.md and the rest) resolve there.
- When you post a comment on the card, end your turn with exactly that comment's text and nothing after it, so the card and this conversation read the same. When a turn needs no comment, end with one short line saying what you did.`;

/** The agent's Claude Code definition: its Paperclip instructions, Paperclip's standing rules, and the notes above. */
export function agentDefinition({ agent, instructions, contract }) {
  const name = String(agent?.name ?? 'Agent').replace(/[\r\n]+/g, ' ').trim() || 'Agent';
  const role = [agent?.title, agent?.role && agent.role !== 'general' ? agent.role : null].filter(Boolean)[0];
  const description = `Paperclip agent: ${name}${role ? `, ${role}` : ''}.`;
  const prompt = [String(instructions ?? '').trim(), String(contract ?? '').trim(), PAPERCLIP_NOTES(name)].filter(Boolean).join('\n\n');
  return { name, description, prompt };
}

const frontmatterValue = (text, key) => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? null;

/**
 * Put the agent where Claude Code finds it. In a plain folder (an org folder) that is .claude/agents/<slug>.md, a
 * file you can open and see in /agents. In a git repo it goes in a --agents file in the run's own folder instead,
 * so nothing lands in the repo. A file of that name that is not this agent's (yours, or another agent's) is never
 * overwritten: the agent gets <slug>-<id> instead. A renamed agent's old file goes.
 */
export async function placeAgent({ cwd, agentId, definition, runtimeDir }) {
  const base = agentSlug(definition.name);
  if (fs.existsSync(path.join(cwd, '.git'))) {
    const file = path.join(runtimeDir, 'agents.json');
    await fsp.mkdir(runtimeDir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ [base]: { description: definition.description, prompt: definition.prompt } }));
    return { slug: base, args: ['--agents', file, '--agent', base], file };
  }
  const dir = path.join(cwd, '.claude', 'agents');
  const owner = async (slug) => frontmatterValue((await fsp.readFile(path.join(dir, `${slug}.md`), 'utf8').catch(() => '')), 'paperclip-agent-id');
  let slug = base;
  for (const candidate of [base, `${base}-${String(agentId).slice(0, 4)}`]) {
    slug = candidate;
    const existing = await fsp.readFile(path.join(dir, `${candidate}.md`), 'utf8').catch(() => null);
    if (existing === null || frontmatterValue(existing, 'paperclip-agent-id') === agentId) break;
  }
  const file = path.join(dir, `${slug}.md`);
  const markdown = `---\nname: ${slug}\ndescription: ${JSON.stringify(definition.description)}\npaperclip-agent-id: ${agentId}\n---\n\n${definition.prompt}\n`;
  if ((await fsp.readFile(file, 'utf8').catch(() => null)) !== markdown) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, markdown);
  }
  for (const other of await fsp.readdir(dir).catch(() => [])) {
    const otherSlug = other.replace(/\.md$/, '');
    if (other.endsWith('.md') && otherSlug !== slug && (await owner(otherSlug)) === agentId) await fsp.rm(path.join(dir, other), { force: true });
  }
  return { slug, args: ['--agent', slug], file };
}

const PEOPLE = new Set(['user', 'board', 'human']);
const REASONS = {
  issue_assigned: 'a new card for you',
  issue_commented: 'a new comment',
  issue_reopened_via_comment: 'the card was reopened',
  issue_status_changed: "the card's status changed",
  issue_children_completed: 'its sub-cards finished',
  issue_continuation_needed: 'the card needs more work',
  issue_recovery_action_restored: 'the card was restored',
  retry_failed_run: 'a retry of the last run',
  heartbeat_timer: 'a scheduled check-in',
  approval_decided: 'an approval was decided',
};

/**
 * The turn's message: what people wrote on the card since the last turn, word for word (and their answers to
 * question cards). A new conversation opens with the card itself. A turn nobody wrote (a timer, an approval, a
 * sub-card finishing) gets one plain line saying why it happened.
 */
export function humanMessage(wake, { newConversation = false, issue = null } = {}) {
  const w = wake ?? {};
  const card = issue ?? w.issue ?? null;
  const words = (w.comments ?? [])
    .filter((c) => c && PEOPLE.has(String(c.authorType ?? c.author?.type ?? '')) && !c.deletedAt
      && c.sourceTrust?.disposition !== 'quarantined' && String(c.body ?? '').trim())
    .map((c) => String(c.body).trim());
  if (w.questionResponse?.summaryMarkdown) words.push(String(w.questionResponse.summaryMarkdown).trim());
  const picked = w.checkboxSelection?.selectedOptions?.map((o) => o.label).filter(Boolean) ?? [];
  if (picked.length) words.push([w.checkboxSelection.prompt, picked.join(', ')].filter(Boolean).join(': '));
  const opening = newConversation && card ? [card.title, card.description].map((s) => String(s ?? '').trim()).filter(Boolean).join('\n\n') : '';
  const said = words.join('\n\n');
  if (opening || said) return [opening, said].filter(Boolean).join('\n\n');
  const reason = String(w.reason ?? '').trim();
  return `(Paperclip: ${REASONS[reason] ?? (reason ? reason.replace(/_/g, ' ') : 'a wake with no new message')}.)`;
}

/** True when a prompt template only names the agent, so it can live in the agent's system prompt. */
export const isAgentOnlyTemplate = (template) => !/\{\{\s*(?!agent\.)[^}]*\}\}/.test(String(template ?? ''));

export function promptTemplateFor(config, context, utils) {
  const custom = typeof config?.promptTemplate === 'string' && config.promptTemplate.trim() ? config.promptTemplate : null;
  return custom ?? (context?.conversationMode === true ? utils.DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : utils.DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
}

/**
 * Paperclip's details for the turn, as its own Claude adapter would have put them in the prompt, minus the
 * standing rules when those live in the agent definition. `resumed` picks Paperclip's shorter version for a
 * conversation that already has the card.
 */
export function turnContext({ utils, context, config, templateData, resumed, rulesInAgent }) {
  const bootstrapTemplate = String(config?.bootstrapPromptTemplate ?? '');
  const bootstrap = !resumed && bootstrapTemplate.trim() ? utils.renderTemplate(bootstrapTemplate, templateData).trim() : '';
  const { taskContextNote, wakePrompt } = utils.selectPaperclipPromptSections(context, { resumedSession: resumed });
  const handoff = String(context?.paperclipSessionHandoffMarkdown ?? '').trim();
  const delta = resumed && wakePrompt.length > 0;
  const rules = rulesInAgent || delta || utils.isPaperclipRecoveryWakePayload(context?.paperclipWake)
    ? '' : utils.renderTemplate(promptTemplateFor(config, context, utils), templateData);
  return utils.joinPromptSections([bootstrap, wakePrompt, handoff, taskContextNote, rules]);
}

// Prompt fields Paperclip's own adapter would render into the message; the native turn sends them as hook context.
export const PROMPT_FIELDS = [
  'paperclipWake', 'paperclipTaskMarkdown', 'paperclipTaskMarkdownCompact', 'paperclipTaskMarkdownAssignment',
  'paperclipTaskMarkdownAssignmentCompact', 'paperclipTaskCommunicationGuidance', 'paperclipSessionHandoffMarkdown',
];

/** The run context for Paperclip's adapter: the prompt fields out (they go to the hook), the message in. */
export function nativeContext(context, message, utils) {
  const out = { ...(context ?? {}) };
  for (const key of PROMPT_FIELDS) delete out[key];
  // The adapter reads the card's work mode from the wake; keep it where it also looks.
  const workMode = utils.readPaperclipIssueWorkModeFromContext(context);
  if (workMode) out.paperclipIssue = { ...(out.paperclipIssue && typeof out.paperclipIssue === 'object' ? out.paperclipIssue : {}), workMode };
  out.paperclipNativeMessage = message;
  return out;
}

/** Write the turn's context (full and shorter versions) and a settings file whose hook hands it to Claude. */
export async function writeTurnHook(dir, { full, delta }, node = process.execPath) {
  await fsp.mkdir(dir, { recursive: true });
  const fullFile = path.join(dir, 'turn-full.md');
  const deltaFile = path.join(dir, 'turn-delta.md');
  await fsp.writeFile(fullFile, full ?? '', { mode: 0o600 });
  await fsp.writeFile(deltaFile, delta ?? full ?? '', { mode: 0o600 });
  const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
  const settings = path.join(dir, 'turn-settings.json');
  const command = [q(node), q(HOOK_SCRIPT), q(fullFile), q(deltaFile)].join(' ');
  await fsp.writeFile(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } }));
  return { settings, fullFile, deltaFile };
}

async function readInstructions(file) {
  if (typeof file !== 'string' || !file.trim()) return { text: '', error: null };
  try {
    return { text: await fsp.readFile(file, 'utf8'), error: null };
  } catch (err) {
    return { text: '', error: `could not read the agent's instructions file "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Everything a native turn changes in what Paperclip's Claude adapter gets: the conversation to continue (or none),
 * the agent, the hook, the message, and the config and context that make the adapter send only the message.
 * `runDir` is the run's own scratch folder (removed after the run).
 */
export async function prepareNativeTurn(ctx, { context = ctx.context, utils, runDir, claudeConfig } = {}) {
  const config = ctx.config ?? {};
  const cwd = claudeRunCwd(context, config);
  const { resume, runtime } = conversationFor(ctx.runtime, cwd, claudeConfig);
  const templateData = {
    agentId: ctx.agent?.id, companyId: ctx.agent?.companyId, runId: ctx.runId, company: { id: ctx.agent?.companyId },
    agent: ctx.agent, run: { id: ctx.runId, source: 'on_demand' }, context,
  };
  const template = promptTemplateFor(config, context, utils);
  const rulesInAgent = isAgentOnlyTemplate(template);
  const instructions = await readInstructions(config.instructionsFilePath);
  const definition = agentDefinition({ agent: ctx.agent, instructions: instructions.text, contract: rulesInAgent ? utils.renderTemplate(template, templateData) : '' });
  const placed = await placeAgent({ cwd, agentId: ctx.agent?.id, definition, runtimeDir: runDir });
  const sections = { utils, context, config, templateData, rulesInAgent };
  const details = { full: turnContext({ ...sections, resumed: false }), delta: turnContext({ ...sections, resumed: true }) };
  const hook = await writeTurnHook(runDir, details);
  const wake = utils.normalizePaperclipWakePayload(context?.paperclipWake);
  const message = humanMessage(wake, { newConversation: !resume, issue: wake?.issue ?? null });
  return {
    cwd, resume, runtime, placed, message, details, card: wake?.issue?.identifier ?? null, warning: instructions.error,
    args: [...placed.args, '--settings', hook.settings],
    overrides: { instructionsFilePath: '', promptTemplate: NATIVE_MESSAGE_TEMPLATE, bootstrapPromptTemplate: '' },
    context: nativeContext(context, message, utils),
  };
}
