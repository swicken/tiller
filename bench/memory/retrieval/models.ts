// The retrieval bench's embedding candidates (memory-v4 plan §1.3), pinned by repo, revision, size and sha256, and their
// download into <root>/models. A file is trusted only through its hash: every load reads it once into one buffer,
// checks that buffer's size and sha256, and parses the same buffer, so nothing changes between the check and the use.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ModelFile { path: string; size: number; sha256: string }

export interface Candidate {
  key: string;
  repo: string;
  revision: string;
  license: string;
  /** model2vec: a static model in safetensors (potion). onnx: a transformer run with onnxruntime-node from --deps. */
  runtime: 'model2vec' | 'onnx';
  dims: number;
  /** onnx only: how token vectors become one. */
  pooling?: 'mean' | 'cls';
  /** onnx only: the model card's query instruction. */
  queryPrefix?: string;
  /** Reported beside potion, never deciding the gate (§8 Q1). */
  exploratory: boolean;
  files: { model: ModelFile; tokenizer: ModelFile };
}

const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';

export const CANDIDATES = {
  potion: {
    key: 'potion', repo: 'minishlab/potion-base-8M', revision: 'bf8b056651a2c21b8d2565580b8569da283cab23', license: 'MIT',
    runtime: 'model2vec', dims: 256, exploratory: false,
    files: {
      model: { path: 'model.safetensors', size: 30_236_760, sha256: 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2' },
      tokenizer: { path: 'tokenizer.json', size: 683_666, sha256: 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50' },
    },
  },
  minilm: {
    key: 'minilm', repo: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', license: 'Apache-2.0',
    runtime: 'onnx', dims: 384, pooling: 'mean', exploratory: true,
    files: {
      model: { path: 'onnx/model_quantized.onnx', size: 22_972_370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
      tokenizer: { path: 'tokenizer.json', size: 711_661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
    },
  },
  bge: {
    key: 'bge', repo: 'Xenova/bge-small-en-v1.5', revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3', license: 'MIT',
    runtime: 'onnx', dims: 384, pooling: 'cls', queryPrefix: BGE_QUERY, exploratory: true,
    files: {
      model: { path: 'onnx/model_quantized.onnx', size: 34_014_426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
      tokenizer: { path: 'tokenizer.json', size: 711_396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
    },
  },
  arctic: {
    key: 'arctic', repo: 'Snowflake/snowflake-arctic-embed-xs', revision: 'd8c86521100d3556476a063fc2342036d45c106f', license: 'Apache-2.0',
    runtime: 'onnx', dims: 384, pooling: 'cls', queryPrefix: BGE_QUERY, exploratory: true,
    files: {
      model: { path: 'onnx/model_quantized.onnx', size: 22_972_992, sha256: 'e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1' },
      tokenizer: { path: 'tokenizer.json', size: 711_649, sha256: '91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854' },
    },
  },
} as const satisfies Record<string, Candidate>;
export type CandidateKey = keyof typeof CANDIDATES;
export const EXPLORATORY = (Object.keys(CANDIDATES) as CandidateKey[]).filter((k) => CANDIDATES[k].exploratory);

export const modelDir = (root: string, c: Candidate): string => join(root, 'models', `${c.key}@${c.revision.slice(0, 7)}`);
export const modelUrl = (c: Candidate, f: ModelFile): string => `https://huggingface.co/${c.repo}/resolve/${c.revision}/${f.path}`;

/** Throws unless buf is exactly the pinned file. */
export function verify(buf: Buffer, f: ModelFile, what: string): Buffer {
  if (buf.length !== f.size) throw new Error(`${what}: ${buf.length} bytes, not the pinned ${f.size}`);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== f.sha256) throw new Error(`${what}: sha256 ${sha}, not the pinned ${f.sha256}`);
  return buf;
}

/**
 * A candidate's file, verified. A missing file is downloaded from its pinned revision (any https redirect is followed;
 * trust rests on the hash), verified in memory and only then renamed into place. A present file that fails is an error,
 * never silently replaced.
 */
export async function modelFile(root: string, c: Candidate, which: keyof Candidate['files'], log = (s: string) => console.error(s)): Promise<Buffer> {
  const f = c.files[which];
  const path = join(modelDir(root, c), f.path);
  if (existsSync(path)) return verify(readFileSync(path), f, path);
  const url = modelUrl(c, f);
  log(`downloading ${url} (${(f.size / 1e6).toFixed(1)} MB)`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = verify(Buffer.from(await res.arrayBuffer()), f, url);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return buf;
}
