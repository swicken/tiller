// Prints every garden run of a home's default memory file with its actions, item texts and reasons; for a trial live.ts
// kept with --keep. Read-only. Run: npx tsx bench/memory/gardener/inspect.mts <TL_HOME>
import { MemoryStore } from '../../../src/daemon/memory-store.js';
if (!process.argv[2]) throw new Error('usage: inspect.mts <TL_HOME>');
const store = new MemoryStore(process.argv[2]);
for (const r of store.runs(undefined)) {
  const run = store.run(undefined, r.id);
  console.log(r.id, r.state, r.note, r.costUsd, JSON.stringify(r.stats.refused));
  for (const a of run.actions!) console.log('  ', a.action, `m${a.itemId}`, '->', `m${a.intoId}`, JSON.stringify(a.itemText), '=>', JSON.stringify(a.intoText), '|', a.reason);
}
store.close();
