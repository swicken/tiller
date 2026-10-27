import { useEffect, useState } from 'react';
import { finished, isAgentKind } from '../src/shared/protocol';
import { ActivityDrawer } from './ActivityDrawer';
import { Dialogs } from './dialogs/Dialogs';
import { DiffPane } from './DiffPane';
import { ExitedCard } from './ExitedCard';
import { ArchivePane } from './transcript/History';
import { useDocumentSync } from './hooks';
import { LastMessagePanel } from './LastMessagePanel';
import { MemoryPane } from './memory/MemoryPane';
import { Palette } from './Palette';
import { Sidebar, useRows } from './sidebar/Sidebar';
import { StatusBar } from './StatusBar';
import { TerminalPane } from './TerminalPane';
import { TitleBar } from './TitleBar';
import { TranscriptPane } from './transcript/TranscriptPane';
import { ConfirmModal, DigestCard, Toasts } from './Toasts';
import { getState, openDialog, selectNode, useStore, viewMemory } from './store';
import { IN_APP } from './url';
import { SettingsPanel } from './settings/SettingsPanel';

if (IN_APP) document.documentElement.dataset.app = '1';

export function App() {
  const [settingsNode, setSettingsNode] = useState<{ id?: string } | null>(null);
  const rows = useRows();
  const node = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  const panel = useStore((s) => s.panel);
  const palette = useStore((s) => s.dialog?.kind === 'palette');
  const diff = useStore((s) => s.diffOpen) && !!node?.worktree;
  const transcript = useStore((s) => s.transcriptOpen) && !!node && isAgentKind(node.kind);
  const memoryTab = useStore((s) => s.memoryOpen) && !!node && isAgentKind(node.kind);
  const archived = useStore((s) => s.archived);
  const memoryView = useStore((s) => s.memoryView);
  useDocumentSync();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsNode) return;
      if (!e.metaKey || e.altKey || e.shiftKey) return; // Ctrl must reach the terminal
      if (e.key === 'k') { e.preventDefault(); openDialog(getState().dialog?.kind === 'palette' ? null : { kind: 'palette' }); }
      else if (e.key === '0') { e.preventDefault(); document.querySelector<HTMLElement>('.tree')?.focus(); }
      else if (/^[1-9]$/.test(e.key)) {
        const row = rows[Number(e.key) - 1];
        if (row) { e.preventDefault(); selectNode(row.node.id); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [rows, settingsNode]);

  return (
    <div className="app">
      {IN_APP && <div className="dragstrip" data-tauri-drag-region />}
      <Sidebar onSettings={() => setSettingsNode({ id: node?.id })} />
      <main className="main">
        {node && !archived && !memoryView ? <TitleBar node={node} /> : null}
        <div className="work">
          <div className="stage">
            <TerminalPane />
            {archived ? <ArchivePane a={archived} />
              : memoryView ? <MemoryPane key={JSON.stringify(memoryView)} target={memoryView} onClose={() => viewMemory(null)} />
              : memoryTab ? <MemoryPane key={node!.id} target={{ nodeId: node!.id }} />
              // Refreshed whenever a turn ends.
              : transcript ? <TranscriptPane key={node!.id} id={node!.id} currentSessionId={node!.sessionId} refresh={finished(node!.status) ? node!.status.changedAt : 'running'} harness={node!.harness} />
              : diff ? <DiffPane node={node!} /> : node?.status.exited && <ExitedCard node={node} />}
            {!node && !archived && !memoryView && (
              <div className="empty">
                <p>No sessions yet.</p>
                <p>Choose New session in the sidebar to get started.</p>
              </div>
            )}
          </div>
          {panel && <LastMessagePanel />}
        </div>
      </main>
      <StatusBar />
      <ActivityDrawer />
      <Toasts />
      <ConfirmModal />
      <DigestCard />
      <Dialogs />
      {palette && <Palette />}
      {settingsNode && <SettingsPanel nodeId={settingsNode.id} onClose={() => setSettingsNode(null)} />}
    </div>
  );
}
