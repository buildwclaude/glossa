// Builds Glossa's offline dictionary from WordNet 3.1 (the `wordnet-db`
// package) into small JSON shards under public/dict, so a lookup only ever
// loads two tiny files and works with no network at all.
//
//   public/dict/i/<prefix>.json   lemma -> "n:offset v:offset ..."  (by first two letters)
//   public/dict/s/<pos><bucket>.json   offset -> [words, gloss, examples]
//
// Run with `npm run dict`. `npm run build` runs it when the output is missing.

import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'dict');
if (process.argv.includes('--if-missing') && existsSync(join(out, 'meta.json'))) process.exit(0);

const require = createRequire(import.meta.url);
const src = require('wordnet-db').path;
const POS = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };
const BUCKET = 1 << 18; // 256 KB of the source data file per synset shard

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'i'), { recursive: true });
mkdirSync(join(out, 's'), { recursive: true });

const index = new Map(); // prefix -> { lemma: refs }
const prefixOf = (w) => {
  const p = w.slice(0, 2).replace(/[^a-z0-9]/g, '_');
  return p.length === 2 ? p : (p + '_').slice(0, 2);
};

let lemmas = 0;
let synsets = 0;

for (const [file, p] of Object.entries(POS)) {
  for (const line of readFileSync(join(src, `index.${file}`), 'utf8').split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const f = line.trim().split(' ');
    const lemma = f[0].replace(/_/g, ' ');
    const synCnt = Number(f[2]);
    const ptrCnt = Number(f[3]);
    const offsets = f.slice(4 + ptrCnt + 2, 4 + ptrCnt + 2 + synCnt);
    const shard = index.get(prefixOf(lemma)) ?? {};
    index.set(prefixOf(lemma), shard);
    const refs = offsets.map((o) => `${p}:${Number(o)}`).join(' ');
    shard[lemma] = shard[lemma] ? `${shard[lemma]} ${refs}` : refs;
    lemmas++;
  }

  const buckets = new Map();
  const data = readFileSync(join(src, `data.${file}`), 'latin1');
  let pos = 0;
  while (pos < data.length) {
    const end = data.indexOf('\n', pos);
    const line = data.slice(pos, end < 0 ? data.length : end);
    const offset = pos;
    pos = end < 0 ? data.length : end + 1;
    if (!line || line.startsWith(' ')) continue;
    const bar = line.indexOf(' | ');
    const head = line.slice(0, bar < 0 ? line.length : bar).split(' ');
    const wCnt = parseInt(head[3], 16);
    const words = [];
    for (let k = 0; k < wCnt; k++) words.push(head[4 + k * 2].replace(/_/g, ' ').replace(/\(.*\)$/, ''));
    const text = bar < 0 ? '' : Buffer.from(line.slice(bar + 3), 'latin1').toString('utf8').trim();
    // The gloss is the definition followed by "quoted examples" separated by ';'.
    const parts = text.split(/;\s*(?=")/);
    const gloss = parts[0].replace(/;\s*$/, '').trim();
    const examples = parts.slice(1).map((e) => e.trim().replace(/^"|"$/g, '').replace(/";?$/, '')).filter(Boolean);
    const key = `${p}${Math.floor(offset / BUCKET)}`;
    const b = buckets.get(key) ?? {};
    buckets.set(key, b);
    b[offset] = examples.length ? [words, gloss, examples.slice(0, 2)] : [words, gloss];
    synsets++;
  }
  for (const [key, b] of buckets) writeFileSync(join(out, 's', `${key}.json`), JSON.stringify(b));
}

for (const [prefix, shard] of index) writeFileSync(join(out, 'i', `${prefix}.json`), JSON.stringify(shard));
// WordNet's licence travels with every copy of the data.
const licence = readFileSync(join(src, 'data.adv'), 'latin1')
  .split('\n')
  .filter((l) => l.startsWith('  '))
  .map((l) => l.replace(/^\s+\d+\s?/, '').trimEnd())
  .join('\n');
writeFileSync(join(out, 'LICENSE.txt'), licence + '\n');
writeFileSync(join(out, 'meta.json'), JSON.stringify({ source: 'WordNet 3.1', bucket: BUCKET, lemmas, synsets }));
console.log(`dictionary: ${lemmas} lemmas, ${synsets} synsets, ${index.size} index shards`);
