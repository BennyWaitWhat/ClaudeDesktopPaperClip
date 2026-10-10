import React, { useEffect, useState } from 'react';
import { usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';

const h = React.createElement;
const INPUT = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30';
const BUTTON = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors hover:bg-accent/50 disabled:opacity-50';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const message = (err) => err?.message ?? String(err);

function FolderRow({ label, hint, value, onChange, onSave, busy }) {
  return h('section', { className: 'space-y-2' },
    h('h3', { className: 'text-sm font-medium' }, label),
    h('div', { className: 'flex items-center gap-2' },
      h('input', { className: INPUT, value, spellCheck: false, onChange: (e) => onChange(e.target.value) }),
      h('button', { type: 'button', className: BUTTON, disabled: busy || !value.trim(), onClick: onSave }, busy ? 'Saving…' : 'Save')),
    h('p', { className: 'text-xs text-muted-foreground' }, hint));
}

/** Settings > Org folder: this org's folder, and where new orgs' folders go. */
export function OrgFolderSettings() {
  const { data, loading, error, refresh } = usePluginData('org-folder', {});
  const setOrgFolder = usePluginAction('set-org-folder');
  const setNewOrgParent = usePluginAction('set-new-org-parent');
  const [orgPath, setOrgPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    if (!data) return;
    setOrgPath(data.folder?.path ?? data.suggested ?? '');
    setParentPath(data.newOrgParent ?? '');
  }, [data]);

  async function run(key, fn, done) {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: done });
      refresh();
    } catch (err) {
      setNote({ ok: false, text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return h('p', { className: 'text-sm text-muted-foreground' }, 'Loading…');
  if (error) return h('p', { className: 'text-sm text-destructive' }, `Org folder settings are unavailable (${message(error)}).`);

  const folder = data?.folder;
  const problems = folder?.configured && !folder.healthy ? (folder.problems ?? []).map((p) => p.message).join(' ') : '';
  const orgHint = !folder?.configured
    ? 'This org has no folder yet, so cards without a project folder run in a hidden Paperclip folder. Save to use this one (it is made if missing).'
    : problems || "A folder you type is made if missing. Moving an org starts its agents' conversations fresh in the new folder.";
  return h('div', { className: 'max-w-3xl space-y-6' },
    h('div', { className: 'space-y-1' },
      h('h2', { className: 'text-lg font-semibold' }, 'Org folder'),
      h('p', { className: 'text-sm text-muted-foreground' },
        "This org's Claude agents work in this folder, unless a card's project has a folder of its own. Claude Desktop lists their conversations under it.")),
    h(FolderRow, {
      label: "This org's folder",
      hint: orgHint,
      value: orgPath,
      onChange: setOrgPath,
      busy: busy === 'org',
      onSave: () => run('org', () => setOrgFolder({ path: orgPath }), 'Saved. Agents use it from their next run.'),
    }),
    h(FolderRow, {
      label: "Where new orgs' folders go",
      hint: 'Every org you create gets a folder here, named after the org, as part of creating it.',
      value: parentPath,
      onChange: setParentPath,
      busy: busy === 'parent',
      onSave: () => run('parent', () => setNewOrgParent({ path: parentPath }), 'Saved for the next org you create.'),
    }),
    note ? h('p', { className: note.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive' }, note.text) : null);
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every Claude agent's conversation for this card, newest first. */
async function cardConversations(companyId, issueId) {
  const agents = await getJson(`/api/companies/${encodeURIComponent(companyId)}/agents`);
  const lists = await Promise.all(agents
    .filter((agent) => agent.adapterType === 'claude_local')
    .map((agent) => getJson(`/api/agents/${encodeURIComponent(agent.id)}/task-sessions`)
      .then((sessions) => sessions.map((session) => ({ ...session, agentName: agent.name })))
      .catch(() => [])));
  return lists.flat()
    .filter((s) => s.taskKey === issueId && UUID.test(String(s.sessionParamsJson?.sessionId ?? '')) && s.sessionParamsJson?.cwd)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .map((s) => ({ agentName: s.agentName, sessionId: s.sessionParamsJson.sessionId, cwd: s.sessionParamsJson.cwd }));
}

/** Card toolbar: open the agent's conversation for this card in Claude Desktop. Hidden until there is one. */
export function OpenInClaudeDesktop({ context }) {
  const open = usePluginAction('open-in-desktop');
  const [conversations, setConversations] = useState([]);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let gone = false;
    if (context?.companyId && context?.entityId) {
      cardConversations(context.companyId, context.entityId)
        .then((list) => { if (!gone) setConversations(list); })
        .catch(() => { if (!gone) setConversations([]); });
    }
    return () => { gone = true; };
  }, [context?.companyId, context?.entityId]);

  if (conversations.length === 0) return null;
  const one = conversations.length === 1;
  return h('div', { className: 'inline-flex flex-wrap items-center gap-2' },
    conversations.map((c) => h('button', {
      key: c.sessionId,
      type: 'button',
      className: BUTTON,
      disabled: busy === c.sessionId,
      title: `${c.agentName}'s conversation for this card, in ${c.cwd}`,
      onClick: async () => {
        setBusy(c.sessionId);
        setNote(null);
        try {
          const result = await open({ sessionId: c.sessionId, cwd: c.cwd });
          setNote(result?.ok ? 'Opened in Claude Desktop.' : `Could not open it (${result?.reason ?? 'no answer'}).`);
        } catch (err) {
          setNote(`Could not open it (${message(err)}).`);
        } finally {
          setBusy(null);
        }
      },
    }, one ? 'Open in Claude Desktop' : `Open ${c.agentName} in Claude Desktop`)),
    note ? h('span', { className: 'text-xs text-muted-foreground' }, note) : null);
}
