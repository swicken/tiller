// Text embedders for the retrieval bench (memory-v4 plan §2.1, §2.7). potion-base-8M is the one ship candidate: a
// Model2Vec static model, so an embedding is the mean of its tokens' rows. MiniLM, bge-small and arctic-xs are
// exploratory transformers. The reference tokenizer (@huggingface/tokenizers) and onnxruntime-node load only from a
// scratch --deps install, never from the repo's dependencies:
//   npm install --prefix ~/.tiller-bench/deps --ignore-scripts onnxruntime-node@1.30.0 @huggingface/tokenizers@0.2.0
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Embedder } from './types.js';
import { CANDIDATES, modelFile, type Candidate, type CandidateKey } from './models.js';

/** Model2Vec's default max_length, and the transformers' position limit. */
export const MAX_TOKENS = 512;

// The slice of @huggingface/tokenizers 0.2.0 the bench uses.
interface Encoding { ids: number[] }
interface Tokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean }): Encoding;
  token_to_id(token: string): number | undefined;
}
// The slice of onnxruntime-node 1.30.0 the bench uses.
interface OrtTensor { data: Float32Array; dims: readonly number[] }
interface OrtSession { inputNames: readonly string[]; outputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>> }
interface Ort {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
}

export async function loadTokenizer(deps: string, json: Buffer): Promise<Tokenizer> {
  const url = pathToFileURL(join(deps, 'node_modules/@huggingface/tokenizers/dist/tokenizers.mjs')).href;
  const { Tokenizer } = await import(url) as { Tokenizer: new (json: object, config: object) => Tokenizer };
  return new Tokenizer(JSON.parse(json.toString('utf8')) as object, {});
}

const loadOrt = (deps: string): Ort => createRequire(join(deps, 'package.json'))('onnxruntime-node') as Ort;

/** The one F32 tensor of a safetensors file, bounds-checked, as [rows, dims]. */
export function readSafetensors(buf: Buffer, name: string): { rows: number; dims: number; data: Float32Array } {
  if (buf.length < 8) throw new Error('safetensors: too short');
  const len = Number(buf.readBigUInt64LE(0));
  if (8 + len > buf.length) throw new Error('safetensors: header past the end');
  const header = JSON.parse(buf.toString('utf8', 8, 8 + len)) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const t = header[name];
  if (!t || t.dtype !== 'F32' || t.shape.length !== 2) throw new Error(`safetensors: no F32 matrix "${name}"`);
  const [rows, dims] = t.shape;
  const [start, end] = t.data_offsets.map((o) => 8 + len + o);
  if (end > buf.length || end - start !== rows * dims * 4) throw new Error(`safetensors: "${name}" out of bounds`);
  const at = buf.byteOffset + start;
  const data = at % 4 === 0 ? new Float32Array(buf.buffer, at, rows * dims) : new Float32Array(buf.buffer.slice(at, at + rows * dims * 4));
  return { rows, dims, data };
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** potion: Model2Vec's encode (no special tokens, unk dropped, the first 512 ids), the mean of their rows, normalized. */
export async function potion(root: string, deps: string): Promise<Embedder> {
  const c = CANDIDATES.potion;
  const tok = await loadTokenizer(deps, await modelFile(root, c, 'tokenizer'));
  const m = readSafetensors(await modelFile(root, c, 'model'), 'embeddings');
  if (m.dims !== c.dims) throw new Error(`potion: ${m.dims} dims, not ${c.dims}`);
  const unk = tok.token_to_id('[UNK]');
  const one = (text: string) => {
    const ids = tok.encode(text, { add_special_tokens: false }).ids.filter((id) => id !== unk).slice(0, MAX_TOKENS);
    const v = new Float32Array(m.dims);
    for (const id of ids) for (let d = 0; d < m.dims; d++) v[d] += m.data[id * m.dims + d];
    return normalize(v); // all zeros when nothing is left: cosine 0 with everything
  };
  return { key: c.key, dims: m.dims, embed: async (texts) => texts.map(one) };
}

/** An exploratory transformer on one CPU thread: [CLS] text [SEP] cut to 512, mean or CLS pooling, normalized. */
export async function transformer(key: Exclude<CandidateKey, 'potion'>, root: string, deps: string): Promise<Embedder> {
  const c: Candidate = CANDIDATES[key];
  const ort = loadOrt(deps);
  const tok = await loadTokenizer(deps, await modelFile(root, c, 'tokenizer'));
  const session = await ort.InferenceSession.create(await modelFile(root, c, 'model'), { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const tensor = (xs: number[]) => new ort.Tensor('int64', BigInt64Array.from(xs, BigInt), [1, xs.length]);
  const one = async (text: string) => {
    let ids = tok.encode(text, { add_special_tokens: true }).ids;
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]];
    const all = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), token_type_ids: tensor(ids.map(() => 0)) };
    const out = await session.run(Object.fromEntries(session.inputNames.map((n) => [n, all[n as keyof typeof all]])));
    const { data, dims } = out[session.outputNames[0]];
    const [n, d] = [dims[1], dims[2]];
    const v = new Float32Array(d);
    if (c.pooling === 'cls') v.set(data.subarray(0, d));
    else for (let t = 0; t < n; t++) for (let j = 0; j < d; j++) v[j] += data[t * d + j] / n;
    return normalize(v);
  };
  return {
    key: c.key, dims: c.dims,
    embed: async (texts, query) => {
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await one(query && c.queryPrefix ? c.queryPrefix + t : t));
      return out;
    },
  };
}

/** Memoizes by text: as-of stores repeat most items, and S stores reuse the tree's. */
export function cached(e: Embedder): Embedder {
  const memo = new Map<string, Float32Array>();
  return {
    key: e.key, dims: e.dims,
    async embed(texts, query) {
      const tag = query ? 'q\0' : 'd\0';
      const missing = [...new Set(texts.filter((t) => !memo.has(tag + t)))];
      if (missing.length) (await e.embed(missing, query)).forEach((v, i) => memo.set(tag + missing[i], v));
      return texts.map((t) => memo.get(tag + t)!);
    },
  };
}

/** potion first, then the exploratory keys asked for, each cached. */
export async function embedders(root: string, deps: string, explore: Exclude<CandidateKey, 'potion'>[] = []): Promise<Embedder[]> {
  const out = [cached(await potion(root, deps))];
  for (const k of explore) out.push(cached(await transformer(k, root, deps)));
  return out;
}

// --- WordPiece golden ids (W1 reads them; run.ts retrieval --golden writes them) ---

/** The edge cases §5 W1 lists, beside the corpus texts. */
export const GOLDEN_EDGE_CASES = [
  'café naïve résumé Ångström',
  '日本語のテキスト 中文 한국어',
  'tab\there\u0000nul\u0007bell\u001bescape\u0085next\r\nline',
  'wait...!!! ?!?! --- *** ((nested)) [[x]] {{y}} ::: ;;',
  `${'a'.repeat(101)} short`,
  'ship it 🚀 ok 👍🏽 family 👨‍👩‍👧 flag 🇨🇦',
  'src/daemon/memory-store.ts:312 bm25(items_fts) `npm test` --scale=20000',
  '',
];

/** The reference tokenizer's raw ids (no special tokens, [UNK] kept) for each text, against potion's pinned tokenizer.json. */
export async function wordpieceGolden(root: string, deps: string, texts: string[]): Promise<{ repo: string; revision: string; tokenizerSha256: string; cases: { text: string; ids: number[] }[] }> {
  const c = CANDIDATES.potion;
  const tok = await loadTokenizer(deps, await modelFile(root, c, 'tokenizer'));
  const cases = [...new Set([...GOLDEN_EDGE_CASES, ...texts])].map((text) => ({ text, ids: tok.encode(text, { add_special_tokens: false }).ids }));
  return { repo: c.repo, revision: c.revision, tokenizerSha256: c.files.tokenizer.sha256, cases };
}
