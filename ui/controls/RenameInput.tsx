import { send } from '../conn';
import { setRenaming } from '../store';

export function RenameInput({ id, title }: { id: string; title: string }) {
  const commit = (v: string) => {
    setRenaming(null);
    if (v.trim() && v.trim() !== title) send({ t: 'rename', id, title: v.trim() });
  };
  return (
    <input
      className="rename" autoFocus defaultValue={title} onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); } if (e.key === 'Escape') setRenaming(null); }}
    />
  );
}
