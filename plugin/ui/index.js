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
  const setDesktop = usePluginAction('set-desktop');
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
    ? 'This org has no folder yet. Save to use this one (it is made if missing).'
    : problems || "A folder you type is made if missing. Moving an org starts its agents' conversations fresh in the new folder.";
  return h('div', { className: 'max-w-3xl space-y-6' },
    h('div', { className: 'space-y-1' },
      h('h2', { className: 'text-lg font-semibold' }, 'Org folder'),
      h('p', { className: 'text-sm text-muted-foreground' },
        "This org's Claude agents live in this folder: one Claude Desktop conversation each, listed under it in Claude Desktop's sidebar.")),
    h('section', { className: 'space-y-2' },
      h('h3', { className: 'text-sm font-medium' }, 'Claude Desktop'),
      data?.desktop
        ? h('p', { className: 'text-xs text-muted-foreground' },
          'This org works from Claude Desktop: each Claude agent has its conversation there, every turn it takes shows here as a run, and what you do here waits for its next turn.')
        : h('div', { className: 'flex items-center gap-2' },
          h('p', { className: 'text-xs text-muted-foreground' }, "This org's Claude agents have not moved to Claude Desktop yet; Paperclip's wakes for them stop with a note until they do."),
          h('button', {
            type: 'button', className: BUTTON, disabled: busy === 'desktop',
            onClick: () => run('desktop', () => setDesktop({ on: true }), 'Moved. Each Claude agent gets its conversation in Claude Desktop within a minute.'),
          }, busy === 'desktop' ? 'Moving…' : 'Move to Claude Desktop'))),
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

/** Card toolbar: open the conversation of the card's agent in Claude Desktop. Hidden when it has none. */
export function OpenInClaudeDesktop({ context }) {
  const open = usePluginAction('open-in-desktop');
  const { data } = usePluginData('agent-conversations', { companyId: context?.companyId });
  const [assignee, setAssignee] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let gone = false;
    if (context?.entityId) {
      getJson(`/api/issues/${encodeURIComponent(context.entityId)}`)
        .then((card) => { if (!gone) setAssignee(card?.assigneeAgentId ?? null); })
        .catch(() => { if (!gone) setAssignee(null); });
    }
    return () => { gone = true; };
  }, [context?.entityId]);

  const conversations = (data?.conversations ?? []).filter((c) => c.agentId === assignee && UUID.test(String(c.sessionId)));
  if (!data?.folder || conversations.length === 0) return null;
  return h('div', { className: 'inline-flex flex-wrap items-center gap-2' },
    conversations.map((c) => h('button', {
      key: c.sessionId,
      type: 'button',
      className: BUTTON,
      disabled: busy === c.sessionId,
      title: `${c.name ?? 'The agent'}'s conversation in Claude Desktop, in ${data.folder}`,
      onClick: async () => {
        setBusy(c.sessionId);
        setNote(null);
        try {
          const result = await open({ sessionId: c.sessionId, cwd: data.folder });
          setNote(result?.alreadyOpen ? 'Already open in Claude Desktop: it is in the sidebar.'
            : result?.ok ? 'Opened in Claude Desktop.' : `Could not open it (${result?.reason ?? 'no answer'}).`);
        } catch (err) {
          setNote(`Could not open it (${message(err)}).`);
        } finally {
          setBusy(null);
        }
      },
    }, c.name ? `Open ${c.name} in Claude Desktop` : 'Open in Claude Desktop')),
    note ? h('span', { className: 'text-xs text-muted-foreground' }, note) : null);
}
