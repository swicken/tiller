import { useEffect, useRef, useState } from 'react';
import { token } from '../url';
import { refreshUsage, send } from '../conn';
import { useStore } from '../store';
import { accountOptionLabel, accountStatus, accountsError, buildChanges, cliStatus, efforts, fieldPreview, groups, inputValue, optionLabel, profileFields, profiles, type Field, type Scope, type SettingsSnapshot } from './settings-model';
import { Modal } from '../controls/Modal';
import { Select } from '../controls/Select';
import { CLAUDE_ACCOUNT_NAME, CLAUDE_ACCOUNT_NAME_RULE, type ClaudeConfigDirCheck } from '../../src/shared/settings';
import './settings.css';

/** A row of the accounts form. was: the configDir of an account already configured (its name is then read-only). */
type SetupRow = { key: number; name: string; configDir: string; create: boolean; was?: string; isDefault?: boolean };
/**
 * The accounts form, open. configure: accounts exist (claude.account is then left alone). home: the account in Claude's
 * default home exists, so `name` is read-only. original: the configured names. touched: by field key, 'shown' once it was
 * changed and left, which is when its error appears.
 */
type Setup = { configure: boolean; name: string; home?: boolean; alternates: SetupRow[]; original: string[]; touched: Record<string, 'dirty' | 'shown'>; confirm: boolean };
let rowKeys = 0;
const suggestDir = (name: string) => `~/.claude-${name}`;
const newRow = (): SetupRow => ({ key: ++rowKeys, name: '', configDir: suggestDir(''), create: true });
const changedDir = (a: SetupRow) => a.was === undefined || a.configDir.trim() !== a.was;

/** What is at a prospective config directory; a failure leaves the daemon's save to report it. */
async function checkDir(path: string): Promise<ClaudeConfigDirCheck> {
  const response = await fetch(`/api/settings?${new URLSearchParams({ claudeConfigDir: path })}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!response.ok) throw new Error(`Directory check failed (${response.status}).`);
  return response.json();
}

async function request(scope: Scope, nodeId: string | undefined, body?: unknown, signal?: AbortSignal): Promise<SettingsSnapshot> {
  const query = new URLSearchParams({ scope, ...(nodeId ? { nodeId } : {}) });
  const response = await fetch(`/api/settings?${query}`, {
    method: body ? 'POST' : 'GET', signal,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Settings request failed (${response.status}).`), { conflict: response.status === 409 });
  if (!data || data.scope !== scope || typeof data.path !== 'string' || typeof data.revision !== 'string' || !data.values || !data.entries || !data.inherited) throw new Error('The server returned an invalid settings snapshot.');
  return data;
}

export function SettingsPanel({ nodeId, onClose }: { nodeId?: string; onClose: () => void }) {
  const usageSources = useStore((s) => s.usageSources);
  const usageScanning = useStore((s) => s.usageScanning);
  const connected = useStore((s) => s.connected);
  const claudeAccounts = useStore((s) => s.claudeAccounts);
  const nodes = useStore((s) => s.nodes);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('Claude');
  const [scope, setScope] = useState<Scope>(nodeId ? 'project' : 'home');
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState<Scope | 'close' | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [reload, setReload] = useState(0);
  // The Claude accounts form (undefined: closed): the account in Claude's default home, then one per other config directory.
  const [setup, setSetup] = useState<Setup>();
  const [seeded, setSeeded] = useState(false);
  // What is at each typed config directory, keyed by that path, so a late reply for an older value never shows for a newer one.
  const [dirChecks, setDirChecks] = useState<Record<string, ClaudeConfigDirCheck>>({});
  const setupDirs = (setup?.alternates ?? []).filter(changedDir).map((a) => a.configDir.trim()).filter(Boolean).join('\n');
  useEffect(() => {
    const pending = setupDirs.split('\n').filter((dir) => dir && !dirChecks[dir]);
    if (!pending.length) return;
    const timer = setTimeout(() => { for (const dir of pending) checkDir(dir).then((check) => setDirChecks((m) => ({ ...m, [dir]: check })), () => {}); }, 350);
    return () => clearTimeout(timer);
  }, [setupDirs]);
  const dirty = Object.keys(drafts).length > 0;
  const sections = [
    // A harness's own group (such as Claude's MCP setting) follows its profile fields in the one section of that title.
    ...Object.keys(efforts).map((harness) => {
      const title = harness === 'pi' ? 'Pi' : harness === 'codex' ? 'Codex' : 'Claude';
      return { title, help: 'Model and effort resolve independently. Spawn options and presets take precedence over these defaults.', fields: [...profileFields(harness as keyof typeof efforts), ...groups.filter((group) => group.title === title).flatMap((group) => group.fields)] };
    }),
    ...groups.filter((group) => (!group.homeOnly || scope === 'home') && !['Claude', 'Pi', 'Codex'].includes(group.title)),
  ];
  const matches = (field: Field, title = '') => !search.trim() || `${title} ${field.label} ${field.key} ${field.help ?? ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const active = sections.find((section) => section.title === category) ?? sections[0];
  const visibleFields = active.fields.filter((field) => matches(field, active.title));
  const fields = sections.flatMap((group) => group.fields);
  useEffect(() => {
    const roots = [document.documentElement, document.body].filter(Boolean);
    const overflow = roots.map((root) => root.style.overflow);
    roots.forEach((root) => { root.style.overflow = 'hidden'; });
    return () => roots.forEach((root, index) => { root.style.overflow = overflow[index]; });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined); setBusy(true); setError(''); setSuccess(''); setConflict(false); setDrafts({});
    // A reload means the file may have changed: an open accounts form would save over it, so it closes, and the list refreshes.
    setSetup(undefined); setDirChecks({}); send({ t: 'claudeAccounts' });
    request(scope, scope === 'project' ? nodeId : undefined, undefined, controller.signal).then(setSnapshot).catch((err) => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [scope, nodeId, reload]);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); if (scope === 'project' && category === 'Daemon') setCategory('Claude'); }, [category, scope]);
  useEffect(() => { if (error || success || discard) content.current?.scrollTo({ top: 0 }); }, [error, success, discard]);
  const leave = (target: Scope | 'close') => {
    if (busy || target === scope) return false;
    if (dirty) { setDiscard(target); return false; }
    if (target === 'close') onClose(); else setScope(target);
    return true;
  };
  const edit = (key: string, raw: string | null) => { setDrafts((d) => ({ ...d, [key]: raw })); setSuccess(''); setError(''); };
  async function save() {
    if (!snapshot || busy) return;
    let changes: Record<string, unknown | null>;
    try { changes = buildChanges(snapshot, drafts, fields); } catch (err) { setError((err as Error).message); return; }
    if (!Object.keys(changes).length) { setDrafts({}); setSuccess('No changes to save.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      setSnapshot(await request(scope, scope === 'project' ? nodeId : undefined, { scope, ...(scope === 'project' ? { nodeId } : {}), revision: snapshot.revision, homeRevision: snapshot.homeRevision, changes }));
      setDrafts({}); setSuccess('Settings saved. New defaults apply on their next use.'); setConflict(false);
      send({ t: 'claudeAccounts' }); // the account views (default, login state) follow the saved config
    } catch (err) { setError((err as Error).message); setConflict(!!(err as { conflict?: boolean }).conflict); }
    finally { setBusy(false); }
  }
  async function saveAccounts() {
    if (!snapshot || !setup || busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const accounts = [...(setup.name.trim() ? [{ name: setup.name.trim() }] : []), ...setup.alternates.map((a) => {
        const dir = a.configDir.trim();
        return { name: a.name.trim(), ...(dir ? { configDir: dir } : {}), create: a.create && changedDir(a) && !dirChecks[dir]?.directory };
      })];
      // claude.account has its own setting once accounts exist; the first save makes the default-home account the default.
      // openedWith: the daemon refuses a list that changed since the form opened, which its WebSocket copy may not show.
      const home = await request('home', undefined, { scope: 'home', revision: snapshot.homeRevision ?? snapshot.revision, openedWith: setup.original, claudeAccounts: { ...(setup.configure ? {} : { account: accounts[0].name }), accounts } });
      setSnapshot(scope === 'home' ? home : await request(scope, nodeId));
      setSetup(undefined); setSeeded(true); setSuccess('Claude accounts saved. Log in each new account below.'); setConflict(false);
      send({ t: 'claudeAccounts' });
    } catch (err) {
      const conflict = !!(err as { conflict?: boolean }).conflict;
      setError((err as Error).message); setConflict(conflict);
      if (conflict) setSetup(undefined); // built on an older file: reload, then open it again
    }
    finally { setBusy(false); }
  }
  function openSetup() {
    setDirChecks({});
    const configured = claudeAccounts ?? [], home = configured.find((a) => !a.configDir);
    setSetup({
      configure: configured.length > 0, name: home?.name ?? '', home: !!home, original: configured.map((a) => a.name), touched: {}, confirm: false,
      alternates: configured.length ? configured.filter((a) => a.configDir).map((a) => ({ key: ++rowKeys, name: a.name, configDir: a.configDir!, create: true, was: a.configDir, isDefault: a.isDefault })) : [newRow()],
    });
  }
  /** Mistakes the form can see before saving, by field: 'default', `${i}-name` or `${i}-dir`. */
  function setupErrors(setup: Setup): Record<string, string> {
    const errors: Record<string, string> = {}, names = setup.name.trim() ? [setup.name.trim()] : [], dirs: string[] = [];
    const nameRule = `Use ${CLAUDE_ACCOUNT_NAME_RULE.replace(/^a name is /, '')}.`;
    if (!setup.home) {
      if (!names[0]) { if (!setup.configure) errors.default = 'Enter a name.'; } // once accounts exist, a default-home account is optional
      else if (!CLAUDE_ACCOUNT_NAME.test(names[0])) errors.default = nameRule;
    }
    setup.alternates.forEach((a, i) => {
      const name = a.name.trim(), dir = a.configDir.trim(), check = changedDir(a) ? dirChecks[dir] : undefined;
      if (a.was !== undefined) { /* configured: its name is fixed */ }
      else if (!name) errors[`${i}-name`] = 'Enter a name.';
      else if (!CLAUDE_ACCOUNT_NAME.test(name)) errors[`${i}-name`] = nameRule;
      else if (setup.original.includes(name)) errors[`${i}-name`] = 'Removed accounts can’t be re-added in the same save.';
      else if (names.includes(name)) errors[`${i}-name`] = 'Another account has this name.';
      names.push(name);
      if (!dir) errors[`${i}-dir`] = 'Enter a config directory.';
      else if (dirs.includes(dir)) errors[`${i}-dir`] = 'Another account uses this directory.';
      else if (check?.error) errors[`${i}-dir`] = check.error;
      else if (check?.exists && !check.directory) errors[`${i}-dir`] = 'This path exists but is not a directory.';
      else if (check && !check.exists && !a.create) errors[`${i}-dir`] = 'This directory does not exist. Tick Create this directory, or enter an existing one.';
      dirs.push(dir);
    });
    return errors;
  }
  function renderSetup(id: string, setup: Setup) {
    const update = (patch: (s: Setup) => Partial<Setup>) => setSetup((s) => s && { ...s, ...patch(s) });
    const row = (i: number, patch: Partial<SetupRow>) => update((s) => ({ alternates: s.alternates.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
    // A field's error shows once it was changed and left; a directory's also once its row's name was.
    const touch = (key: string) => update((s) => ({ touched: { ...s.touched, [key]: s.touched[key] ?? 'dirty' } }));
    const leave = (key: string) => update((s) => (s.touched[key] === 'dirty' ? { touched: { ...s.touched, [key]: 'shown' } } : {}));
    const errors = setupErrors(setup);
    const field = (key: string, touchKeys: string[]) => {
      const message = touchKeys.some((k) => setup.touched[k] === 'shown') ? errors[key] : undefined;
      return { inputProps: { ...(message ? { 'aria-invalid': true, 'aria-describedby': `${id}-${key}-error` } : {}), onBlur: () => leave(touchKeys[0]) },
        error: message && <p className="settings-account-note settings-error" id={`${id}-${key}-error`}>{message}</p> };
    };
    // Accounts that nodes still record: removing one, or moving its directory, is allowed but only on purpose. A node looks up
    // its account's directory at each launch, so after a restart a moved account's nodes would lose their transcripts.
    const removed = setup.original.filter((n) => n !== setup.name.trim() && !setup.alternates.some((a) => a.name.trim() === n));
    const moved = setup.alternates.filter((a) => a.was !== undefined && changedDir(a)).map((a) => a.name);
    const inUse = [...removed, ...moved].flatMap((name) => { const titles = Object.values(nodes ?? {}).filter((n) => n.account === name).map((n) => n.title); return titles.length ? [{ name, titles, moved: moved.includes(name) }] : []; });
    const removing = inUse.some((u) => !u.moved);
    const home = field('default', ['default']);
    return <div className="settings-account-setup">
      <p className="settings-account-note">{setup.configure ? 'Add or remove accounts, or change a config directory. Names cannot change: nodes and repositories refer to accounts by name.'
        : 'Name your existing login in Claude’s default home (~/.claude); it becomes the default account. Add an account for each other login, each in its own config directory.'}</p>
      <label htmlFor={`${id}-default`}>{setup.configure ? 'Account in Claude’s default home (~/.claude)' : 'Default account name'}</label>
      <input id={`${id}-default`} value={setup.name} disabled={busy} readOnly={setup.home} placeholder="personal" {...home.inputProps} onChange={(e) => { touch('default'); update(() => ({ name: e.target.value })); }} />
      {home.error}
      {setup.alternates.map((a, i) => {
        const name = field(`${i}-name`, [`${a.key}-name`]), dir = field(`${i}-dir`, [`${a.key}-dir`, `${a.key}-name`]);
        return <fieldset className="settings-account-row" key={a.key}>
          <legend>{a.was === undefined ? `Account ${i + 2}` : a.name}</legend>
          <label htmlFor={`${id}-${i}-name`}>Name</label>
          {/* While the directory is still the suggestion for the old name, it follows the name. */}
          <input id={`${id}-${i}-name`} value={a.name} disabled={busy} readOnly={a.was !== undefined} placeholder="work" {...name.inputProps} onChange={(e) => { touch(`${a.key}-name`); row(i, { name: e.target.value, ...(a.configDir === suggestDir(a.name) ? { configDir: suggestDir(e.target.value) } : {}) }); }} />
          {name.error}
          <label htmlFor={`${id}-${i}-dir`}>Config directory</label>
          <input id={`${id}-${i}-dir`} value={a.configDir} disabled={busy} {...dir.inputProps} onChange={(e) => { touch(`${a.key}-dir`); row(i, { configDir: e.target.value }); }} />
          {dir.error}
          {a.was !== undefined && changedDir(a) && <p className="settings-account-note" id={`${id}-${i}-relogin`}>A new directory is a separate login: log in to {a.name} again after saving.</p>}
          {!changedDir(a) ? null : dirChecks[a.configDir.trim()]?.directory ? <p className="settings-account-note" id={`${id}-${i}-exists`}><em>Directory exists</em></p>
            : <label><input id={`${id}-${i}-create`} type="checkbox" checked={a.create} disabled={busy} onChange={(e) => row(i, { create: e.target.checked })} /> Create this directory</label>}
          <button type="button" className="settings-reset" disabled={busy || a.isDefault} aria-label={`Remove ${a.name.trim() || `account ${i + 2}`}`} aria-describedby={a.isDefault ? `${id}-${i}-default` : undefined} onClick={() => update((s) => ({ alternates: s.alternates.filter((_, j) => j !== i) }))}>Remove</button>
          {a.isDefault && <p className="settings-account-note" id={`${id}-${i}-default`}>This is the default account, so it cannot be removed. Choose another default first.</p>}
        </fieldset>;
      })}
      {inUse.length > 0 && <div className="settings-account-note settings-error" id={`${id}-in-use`} role="status">
        <ul>{inUse.map((u) => <li key={u.name}>{u.name} is used by {u.titles.join(', ')}.</li>)}</ul>
        {removing && <p>Those nodes keep running, but restarting or resuming them will fail until the account is configured again.</p>}
        {inUse.some((u) => u.moved) && <p>Restarting or resuming them will run them in the new directory, which has none of their transcripts.</p>}
        <label><input id={`${id}-confirm`} type="checkbox" checked={setup.confirm} disabled={busy} onChange={(e) => update(() => ({ confirm: e.target.checked }))} /> {removing ? 'Remove anyway' : 'Change anyway'}</label>
      </div>}
      <div className="settings-detail">
        <button type="button" className="btn" disabled={busy} onClick={() => update((s) => ({ alternates: [...s.alternates, newRow()] }))}>Add another account</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setSetup(undefined); setDirChecks({}); }}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || Object.keys(errors).length > 0 || (inUse.length > 0 && !setup.confirm)} onClick={() => void saveAccounts()}>Save configuration</button>
      </div>
    </div>;
  }
  // The account options come from the configured accounts, so this field has its own control.
  function renderAccount(field: Field) {
    if (!snapshot) return null;
    const { key, label } = field, id = `setting-${key}`;
    const drafted = Object.hasOwn(drafts, key);
    const custom = drafted ? drafts[key] !== null : Object.hasOwn(snapshot.values, key);
    const value = drafted ? drafts[key] ?? '' : custom ? String(snapshot.values[key]) : '';
    const error = accountsError(claudeAccounts), globalDefault = snapshot.inherited[key]?.value;
    const shown = claudeAccounts?.find((a) => a.name === (value || snapshot.claudeAccount?.effective));
    const { effective, project } = snapshot.claudeAccount ?? {};
    // A parent folder in some account's projects decides when this repository lists none itself.
    const none = scope === 'home' ? 'None' : project && project !== snapshot.projectPath ? `No repository-specific account (${effective} via ${project})`
      : `Use global default (${typeof globalDefault === 'string' ? globalDefault : 'none'})`;
    // Just after setup, every logged-out account's login is listed instead of only the shown one's.
    const loggedOut = shown?.loggedIn === false && !seeded, probeError = shown?.error, logins = seeded ? claudeAccounts?.filter((a) => a.loggedIn === false) ?? [] : [];
    const described = [`${id}-help`, `${id}-status`, ...(loggedOut ? [`${id}-login`] : []), ...(logins.length ? [`${id}-logins`] : []), ...(probeError ? [`${id}-error`] : [])].join(' ');
    // Only an unknown claude.account (say, an account since deleted) can be fixed from here: by removing it.
    const resettable = scope === 'home' && !!error?.startsWith('claude.account in ') && Object.hasOwn(snapshot.values, key);
    return <div className="settings-field" key={key}>
      <div className="settings-label"><label id={`${id}-label`} htmlFor={id}>{label}</label><p id={`${id}-help`}>{field.help}</p></div>
      <div className="settings-control">
        {error ? <>
          <p className="settings-account-note" role="alert">{error}</p>
          {resettable && <div className="settings-detail">
            <button type="button" className="settings-reset" disabled={busy || drafted} aria-label={`Reset to default: ${label}`} onClick={() => edit(key, null)}>Reset to default</button>
            {drafted && <span className="settings-pending">Unsaved</span>}
          </div>}
        </>
        : !claudeAccounts || (seeded && !claudeAccounts.length) ? <p className="settings-account-note">Loading Claude accounts…</p>
        : setup ? renderSetup(id, setup)
        : !claudeAccounts.length ? <>
          <p className="settings-account-note">Tiller runs Claude nodes with your default Claude login (~/.claude). If you use more than one Claude account, for example in two Teams, add them here and choose which account each repository uses.</p>
          <div className="settings-detail"><button type="button" className="btn" disabled={busy} onClick={openSetup}>Set up multiple accounts</button></div>
        </>
        : <>
          <Select id={id} disabled={busy} value={value} aria-describedby={described} onChange={(e) => edit(key, e.target.value || null)}>
            <option value="">{none}</option>
            {value && !claudeAccounts.some((a) => a.name === value) && <option value={value}>{value} (not configured)</option>}
            {claudeAccounts.map((a) => <option key={a.name} value={a.name}>{accountOptionLabel(a)}</option>)}
          </Select>
          <p className="settings-account-note" id={`${id}-status`}>{accountStatus(snapshot)}</p>
          {loggedOut && <p className="settings-account-note" id={`${id}-login`}>{shown.name} is not logged in. Log in with <code className="mono">{shown.loginCommand}</code>, or /login in a node’s terminal.</p>}
          {logins.length > 0 && <div className="settings-account-note" id={`${id}-logins`}>
            <p>Log in each account once from a terminal, then run Claude once in each project under it to accept its workspace trust:</p>
            <ul>{logins.map((a) => <li key={a.name}>{a.name}: <code className="mono">{a.loginCommand}</code>, then <code className="mono">{a.loginCommand.replace(/ auth login$/, '')}</code> in each project</li>)}</ul>
          </div>}
          {probeError && <p className="settings-account-note" id={`${id}-error`}>{probeError}</p>}
          <div className="settings-detail"><button type="button" className="btn" disabled={busy} onClick={openSetup}>Configure</button></div>
          {(custom || drafted) && <div className="settings-detail">
            {custom && <><span>Custom setting</span><span aria-hidden="true">·</span><button type="button" className="settings-reset" disabled={busy} aria-label={`Reset to default: ${label}`} onClick={() => edit(key, null)}>Reset to default</button></>}
            {drafted && <span className="settings-pending">Unsaved</span>}
          </div>}
        </>}
      </div>
    </div>;
  }
  function renderField(field: Field) {
    if (!snapshot) return null;
    if (field.key === 'claude.account') return renderAccount(field);
    const { key, label } = field;
    const { drafted, explicit, entry, raw, previewUnavailable } = fieldPreview(snapshot, drafts, field);
    const action = explicit ? scope === 'project' ? 'Remove repository override' : 'Use inherited default' : scope === 'project' ? 'Customize for this repository' : 'Customize globally';
    const id = `setting-${key}`;
    const gateCommand = Object.hasOwn(drafts, 'gate.command') ? drafts['gate.command'] === null ? snapshot.inherited['gate.command']?.value : drafts['gate.command'] : snapshot.entries['gate.command']?.value;
    const needsCommand = (key === 'gate.retries' || key === 'gate.timeoutMinutes') && !(typeof gateCommand === 'string' && gateCommand.trim());
    const value = !explicit && !drafted && !previewUnavailable ? inputValue(entry?.value, field) : raw;
    const defaultSuffix = !explicit && !previewUnavailable ? ' (default)' : '';
    const showDetail = previewUnavailable || explicit || drafted;
    const props = { id, disabled: busy || needsCommand, value, placeholder: previewUnavailable ? 'Preview available after save' : key === 'gate.command' ? 'No completion check configured' : undefined, 'aria-describedby': `${id}-help`, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => edit(key, e.target.value) };
    return <div className={`settings-field${key === 'gate.command' ? ' settings-command-field' : ''}`} key={key}>
      <div className="settings-label"><label id={`${id}-label`} htmlFor={id}>{key.startsWith('profiles.') ? key.endsWith('.model') ? 'Model' : 'Effort' : label}</label>
        <p id={`${id}-help`}>{needsCommand ? 'Configure a check command to enable this setting.' : field.help ?? field.description}</p>
      </div>
      <div className="settings-control">
        {field.type === 'boolean' ? <button id={id} className="settings-toggle" type="button" role="switch" aria-checked={value === 'true'} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} disabled={busy} onClick={() => edit(key, value === 'true' ? 'false' : 'true')}><span className="settings-switch-track"><span /></span><span>{value === 'true' ? 'On' : 'Off'}</span></button>
        : field.options ? <Select {...props}>
          {!value && <option value="">{previewUnavailable ? 'Preview available after save' : `Harness default / unset${defaultSuffix}`}</option>}
          {value && !field.options.includes(value) && <option value={value}>{value}{defaultSuffix || ' (current)'}</option>}
          {field.options.map((option) => <option key={option} value={option}>{optionLabel(key, option)}{option === value ? defaultSuffix : ''}</option>)}
        </Select> : field.type === 'lines' ? <textarea {...props} rows={3} /> : <input {...props} list={key.startsWith('profiles.claude.') && key.endsWith('.model') ? 'settings-claude-models' : undefined} type={field.type === 'number' ? 'number' : 'text'} min={field.min} step={field.integer ? 1 : 'any'} />}
        {showDetail && <div className="settings-detail">
          {previewUnavailable && <span>Preview unavailable until legacy role changes are saved.</span>}
          {explicit && <span>Custom setting</span>}
          {explicit && <><span aria-hidden="true">·</span><button type="button" className="settings-reset" disabled={busy} aria-label={`${action}: ${label}`} onClick={() => edit(key, null)}>Reset to default</button></>}
          {drafted && <span className="settings-pending">Unsaved</span>}
        </div>}
      </div>
    </div>;
  }
  function navButton(title: string) {
    const section = sections.find((section) => section.title === title);
    if (search.trim() && title !== 'CLI diagnostics' && !section?.fields.some((field) => matches(field, title))) return null;
    if (search.trim() && title === 'CLI diagnostics' && !'cli diagnostics supported tools'.includes(search.toLowerCase())) return null;
    return <button key={title} className="settings-nav-item" aria-pressed={category === 'CLI diagnostics' ? title === category : active.title === title} onClick={() => setCategory(title)}><SettingsIcon name={title} /><span>{title}</span></button>;
  }

  return <Modal className="settings-dialog" label="Settings" restoreFocus blockGlobalShortcuts onClose={() => leave('close')}>
    <aside className="settings-sidebar">
      <h2 id="settings-title">Settings</h2>
      <div className="settings-search"><SettingsIcon name="Search" /><input autoFocus type="search" aria-label="Search settings" placeholder="Search settings" value={search} onChange={(event) => { const query = event.target.value; setSearch(query); if (query.trim()) { const first = sections.find((section) => section.fields.some((field) => `${section.title} ${field.label} ${field.key} ${field.help ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))); if (first) setCategory(first.title); } }} /></div>
      <nav className="settings-categories" aria-label="Settings categories">
        <div className="settings-nav-group"><h3>Agents</h3>{['Claude', 'Pi', 'Codex'].map(navButton)}</div>
        <div className="settings-nav-group"><h3>Workflow</h3>{['Notifications', 'Limits', 'Worktrees', 'Approvals & checks'].map(navButton)}</div>
        <details className="settings-advanced" open={search.trim() ? true : undefined}><summary>Advanced</summary>{['Legacy Claude roles', ...(scope === 'home' ? ['Daemon'] : []), 'CLI diagnostics'].map(navButton)}</details>
      </nav>
    </aside>
    <div className="settings-workspace">
    <header className="settings-header">
      <div className="settings-scope"><label htmlFor="settings-scope">Editing settings for</label><div className="settings-scope-picker"><SettingsIcon name="Globe" /><Select id="settings-scope" aria-label="Settings scope" value={scope} disabled={busy} onChange={(event) => leave(event.target.value as Scope)}><option value="home">All repositories</option><option value="project" disabled={!nodeId}>{snapshot?.projectPath?.split('/').filter(Boolean).at(-1) ?? 'This repository'}</option></Select></div></div>
      <button className="settings-close" disabled={busy} onClick={() => leave('close')}>Close</button>
      <p className="settings-inheritance-copy">{scope === 'project' ? 'Repository settings override shared defaults. Unset values inherit from all repositories or built-in defaults.' : 'Shared defaults for all repositories. Individual repositories can override these settings.'}{!nodeId && ' Select a node to edit repository settings.'}</p>
    </header>
    <div className="settings-content" ref={content} aria-busy={busy}>
      {discard && <div className="settings-notice" role="alert"><p>Discard unsaved changes?</p><button className="btn" onClick={() => setDiscard(null)}>Keep editing</button>{' '}<button className="btn danger" onClick={() => { const target = discard; setDiscard(null); setDrafts({}); if (target === 'close') onClose(); else setScope(target); }}>Discard changes</button></div>}
      {(error || conflict) && <div className="settings-notice settings-error" role="alert"><p>{error || 'Settings changed on disk. Reload the latest settings before saving.'}</p>{conflict ? <><p>The file changed since it was loaded. Reload discards your draft and loads the latest values.</p><button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Reload latest settings</button></> : !snapshot && <button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>Retry</button>}</div>}
      {success && <p className="settings-success" role="status">{success}</p>}
      {!snapshot && busy && <p role="status">Loading settings…</p>}
      {category === 'CLI diagnostics' && <div className="settings-page-heading"><h1>CLI diagnostics</h1><p>Check which supported tools are available to the daemon.</p></div>}
      {category === 'CLI diagnostics' && <section className="settings-clis" aria-labelledby="settings-clis-title">
        <div className="settings-clis-heading"><h3 id="settings-clis-title">Supported CLIs</h3><button className="btn" disabled={!connected || usageSources === undefined || usageScanning} onClick={refreshUsage}>{usageScanning ? 'Scanning tools…' : 'Rescan'}</button></div>
        {!usageSources && <p>CLI detection is unavailable from this daemon. Update the daemon to enable discovery and rescan.</p>}
        <p>Executable checks use the daemon’s launch PATH. Sign-in and quota availability are separate.</p>
        {!connected && <p>Daemon disconnected. Showing retained checks.</p>}
        <ul>{(['claude', 'codex', 'pi'] as const).map((tool) => {
          const source = usageSources?.find((source) => source.id === `discovery:${tool}`);
          return <li key={tool}><strong>{tool}</strong><span>{cliStatus(source)}</span>{source?.version && <small>Version: {source.version}</small>}{source?.detail && <small>{source.detail}</small>}{source?.checkedAt !== undefined && <small>Checked <time dateTime={new Date(source.checkedAt).toISOString()}>{new Date(source.checkedAt).toLocaleString()}</time></small>}</li>;
        })}</ul>
      </section>}
      {snapshot && <form id="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <datalist id="settings-claude-models">{['opus', 'sonnet', 'haiku'].map((model) => <option key={model} value={model} />)}</datalist>
        {category !== 'CLI diagnostics' && <section className="settings-section" aria-labelledby="settings-category-title">
          <div className="settings-page-heading"><h1 id="settings-category-title">{active.title}{['Claude', 'Codex', 'Pi'].includes(active.title) ? ' task profiles' : ''}</h1>
          {active.help && <p>{active.help}</p>}</div>
          {['Claude', 'Codex', 'Pi'].includes(active.title) ? <>
            {profiles.filter((profile) => visibleFields.some((field) => field.key.includes(`.${profile}.`))).map((profile) => <fieldset className="settings-profile" key={profile}><legend>{profile.charAt(0).toUpperCase() + profile.slice(1)}</legend>{visibleFields.filter((field) => field.key.includes(`.${profile}.`)).map(renderField)}</fieldset>)}
            {visibleFields.some((field) => !field.key.startsWith('profiles.')) && <section className="settings-subsection"><h2>{active.title} nodes</h2>{visibleFields.filter((field) => !field.key.startsWith('profiles.')).map(renderField)}</section>}
          </> : active.title === 'Approvals & checks' ? <>
            {visibleFields.some((field) => field.key.startsWith('approvals.')) && <section className="settings-subsection"><h2>Approvals</h2>{visibleFields.filter((field) => field.key.startsWith('approvals.')).map(renderField)}</section>}
            {visibleFields.some((field) => field.key.startsWith('gate.')) && <section className="settings-subsection"><h2>Completion checks</h2><p>Require a command to pass before a worker reports success.</p>{visibleFields.filter((field) => field.key.startsWith('gate.')).map(renderField)}</section>}
          </> : visibleFields.map(renderField)}
          {search.trim() && !visibleFields.length && <p role="status">No matching settings. Try another search.</p>}
        </section>}
      </form>}
    </div>
    <footer className="settings-footer"><span role="status">{dirty ? `${Object.keys(drafts).length} unsaved ${Object.keys(drafts).length === 1 ? 'change' : 'changes'}` : 'All changes saved'}</span><button className="btn" disabled={busy || !dirty} onClick={() => { setDrafts({}); setError(''); setSuccess(''); }}>Discard changes</button><button className="btn primary" form="settings-form" type="submit" disabled={busy || !snapshot || !dirty || conflict}>{busy ? 'Please wait…' : 'Save changes'}</button></footer>
    </div>
  </Modal>;
}

function SettingsIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Search: 'm21 21-5-5 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    Globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
    Claude: 'M12 3v18 M3 12h18 M5.6 5.6l12.8 12.8 M5.6 18.4 18.4 5.6 M8.5 3.7l7 16.6 M3.7 15.5l16.6-7',
    Pi: 'M5 7h14 M8 7v13 M16 7v10q0 3 3 3',
    Codex: 'm8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
    Notifications: 'M5 17h14l-2-3v-4a5 5 0 0 0-10 0v4l-2 3 M10 21h4 M12 3v2',
    Limits: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    Worktrees: 'M6 3v12a4 4 0 0 0 4 4h8 M6 8h8a4 4 0 0 0 4-4 M3 3h6 M15 3h6 M15 22h6',
    'Approvals & checks': 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3 M8 12l3 3 5-6',
  };
  return <svg className="settings-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? 'M5 7h14 M5 12h14 M5 17h14 M8 5v4 M16 10v4 M10 15v4'} /></svg>;
}
