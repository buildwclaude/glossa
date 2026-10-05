/**
 * Word lookup, inside the app and offline first.
 *
 * 1. The bundled WordNet (155k English words) — instant, no network.
 *    Inflected forms are reduced to their dictionary form first
 *    ("running" → run, "geese" → goose, "happier" → happy).
 * 2. If the word isn't there (names, other languages, slang) and there is a
 *    connection: Wiktionary, then Wikipedia's summary — fetched as data and
 *    shown in the same sheet, never by sending you to a browser.
 */

export type Sense = { gloss: string; examples: string[]; synonyms: string[] };
export type Group = { pos: string; senses: Sense[] };
export type Entry = {
  word: string;
  /** The form that was found, if different from what was pressed. */
  lemma: string;
  groups: Group[];
  source: 'WordNet' | 'Wiktionary' | 'Wikipedia';
  url?: string;
  /** A second reading, e.g. "saw" the tool under "see". */
  also?: Entry;
};

const POS_NAME: Record<string, string> = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };
const base = () => new URL('dict/', document.baseURI).href;

const cache = new Map<string, Promise<unknown>>();
function json<T>(path: string): Promise<T | null> {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(base() + path)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return cache.get(path) as Promise<T | null>;
}

let bucket = 1 << 18;
const metaP = json<{ bucket: number }>('meta.json').then((m) => m && (bucket = m.bucket));

const prefixOf = (w: string) => {
  const p = w.slice(0, 2).replace(/[^a-z0-9]/g, '_');
  return p.length === 2 ? p : (p + '_').slice(0, 2);
};

async function refs(lemma: string): Promise<string[]> {
  const shard = await json<Record<string, string>>(`i/${prefixOf(lemma)}.json`);
  return shard?.[lemma]?.split(' ') ?? [];
}

/* ---------------------------------------------------------- morphology */

const IRREGULAR: Record<string, string> = Object.fromEntries(
  `was:be were:be been:be am:be is:be are:be has:have had:have did:do does:do done:do went:go gone:go
  came:come saw:see seen:see took:take taken:take gave:give given:give made:make knew:know known:know
  thought:think told:tell found:find felt:feel left:leave brought:bring began:begin begun:begin kept:keep
  held:hold stood:stand heard:hear meant:mean met:meet ran:run paid:pay sat:sit spoke:speak spoken:speak
  lay:lie lain:lie led:lead grew:grow grown:grow lost:lose fell:fall fallen:fall sent:send built:build
  understood:understand drew:draw drawn:draw broke:break broken:break spent:spend rose:rise risen:rise
  drove:drive driven:drive bought:buy wore:wear worn:wear chose:choose chosen:choose sought:seek
  threw:throw thrown:throw caught:catch dealt:deal won:win forgot:forget forgotten:forget sang:sing sung:sing
  wrote:write written:write ate:eat eaten:eat flew:fly flown:fly hid:hide hidden:hide shook:shake shaken:shake
  struck:strike stricken:strike swore:swear sworn:swear taught:teach fought:fight bore:bear borne:bear born:bear
  slept:sleep swept:sweep wept:weep crept:creep fled:flee bent:bend lent:lend bled:bleed fed:feed
  froze:freeze frozen:freeze stole:steal stolen:steal woke:wake woken:wake rode:ride ridden:ride
  sank:sink sunk:sink swam:swim swum:swim tore:tear torn:tear beat:beat beaten:beat bit:bite bitten:bite
  blew:blow blown:blow dug:dig hung:hang laid:lay sold:sell shot:shoot shone:shine slid:slide spun:spin
  sprang:spring sprung:spring stuck:stick stung:sting strove:strive swung:swing trod:tread wove:weave
  woven:weave wound:wind withdrew:withdraw forgave:forgive forgiven:forgive overcame:overcome
  children:child men:man women:woman feet:foot teeth:tooth geese:goose mice:mouse lice:louse oxen:ox
  people:person dice:die criteria:criterion phenomena:phenomenon data:datum
  better:good best:good worse:bad worst:bad further:far farther:far furthest:far elder:old eldest:old
  more:much most:much less:little least:little`
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split(':') as [string, string]),
);

const RULES: Record<string, [string, string][]> = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'], ['ves', 'f'], ['ves', 'fe']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', ''], ['ied', 'y'], ['ying', 'ie']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'], ['ier', 'y'], ['iest', 'y']],
};

/** Every plausible dictionary form of a word, most likely first. */
export function candidates(raw: string): string[] {
  const w = raw.toLowerCase();
  const out = [w];
  const irr = IRREGULAR[w];
  if (irr) out.push(irr);
  for (const rules of Object.values(RULES)) {
    for (const [suf, rep] of rules) {
      if (w.length > suf.length + 1 && w.endsWith(suf)) {
        const stem = w.slice(0, -suf.length) + rep;
        out.push(stem);
        // running → run, bigger → big, stopped → stop
        if (!rep && /([b-df-hj-np-tv-z])\1$/.test(stem)) out.push(stem.slice(0, -1));
      }
    }
  }
  if (w.endsWith("'s") || w.endsWith('’s')) out.unshift(w.slice(0, -2));
  return [...new Set(out)];
}

/** Trims what a long-press picks up around a word. */
export function clean(word: string) {
  return word
    .normalize('NFC')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

async function entryFor(word: string, form: string): Promise<Entry | null> {
  const r = await refs(form);
  if (!r.length) return null;
  const groups = new Map<string, Sense[]>();
  await Promise.all(
    r.map(async (ref, order) => {
      const [p, o] = ref.split(':') as [string, string];
      const off = Number(o);
      const shard = await json<Record<string, [string[], string, string[]?]>>(`s/${p}${Math.floor(off / bucket)}.json`);
      const syn = shard?.[off];
      if (!syn) return;
      const pos = POS_NAME[p] ?? p;
      const list = groups.get(pos) ?? [];
      groups.set(pos, list);
      list[order] = {
        gloss: syn[1],
        examples: syn[2] ?? [],
        synonyms: syn[0].filter((s) => s.toLowerCase() !== form).slice(0, 5),
      };
    }),
  );
  const result = [...groups].map(([pos, senses]) => ({ pos, senses: senses.filter(Boolean) }));
  return result.length ? { word, lemma: form, groups: result, source: 'WordNet' } : null;
}

async function wordnet(word: string): Promise<Entry | null> {
  await metaP;
  const lower = word.toLowerCase();
  const forms = candidates(word);
  // A phrase or hyphenated word can also be listed with spaces.
  if (/[-\s]/.test(word)) forms.push(lower.replace(/-/g, ' '));
  // An irregular form reads as its dictionary word first ("saw" → see),
  // with the word's own meaning ("a saw") kept underneath.
  const irr = IRREGULAR[lower];
  if (irr) {
    const main = await entryFor(word, irr);
    const own = await entryFor(word, lower);
    if (main) return own ? { ...main, also: own } : main;
  }
  for (const form of forms) {
    const hit = await entryFor(word, form);
    if (hit) return hit;
  }
  return null;
}

/* -------------------------------------------------------------- online */

const text = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, link, sup.reference').forEach((n) => n.remove());
  return doc.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
};

async function wiktionary(word: string, lang: string): Promise<Entry | null> {
  const tries = [word, word.toLowerCase()].filter((v, i, a) => a.indexOf(v) === i);
  for (const w of tries) {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`, {
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const data = (await res.json()) as Record<string, { partOfSpeech: string; definitions: { definition: string; examples?: string[] }[] }[]>;
    // The book's language first, then English, then whatever there is.
    const keys = Object.keys(data);
    const key = keys.find((k) => k === lang) ?? keys.find((k) => k === 'en') ?? keys[0];
    const list = key ? data[key] : undefined;
    if (!list?.length) continue;
    const groups = list
      .map((g) => ({
        pos: g.partOfSpeech.toLowerCase(),
        senses: g.definitions
          .map((d) => ({ gloss: text(d.definition), examples: (d.examples ?? []).slice(0, 1).map(text), synonyms: [] }))
          .filter((s) => s.gloss)
          .slice(0, 4),
      }))
      .filter((g) => g.senses.length);
    // "Symbol" entries (ISO codes and the like) only when there's nothing else.
    const real = groups.filter((g) => !/^(symbol|abbreviation|letter|number)$/.test(g.pos));
    if (real.length) groups.splice(0, groups.length, ...real);
    if (groups.length) return { word, lemma: w, groups, source: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${encodeURIComponent(w)}` };
  }
  return null;
}

async function wikipedia(word: string, lang: string): Promise<Entry | null> {
  const host = /^[a-z]{2,3}$/.test(lang) ? lang : 'en';
  const res = await fetch(`https://${host}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`, {
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const d = (await res.json()) as { type?: string; extract?: string; description?: string; title?: string; content_urls?: { mobile?: { page?: string } } };
  if (!d.extract || d.type === 'disambiguation') return null;
  return {
    word,
    lemma: d.title ?? word,
    groups: [{ pos: d.description ?? 'encyclopedia', senses: [{ gloss: d.extract, examples: [], synonyms: [] }] }],
    source: 'Wikipedia',
    url: d.content_urls?.mobile?.page,
  };
}

/* WordNet leaves out the small words; these are the ones people press. */
const FUNCTION_WORDS: Record<string, [string, string]> = {
  the: ['article', 'used before a noun to point to a particular person or thing already known or about to be identified'],
  a: ['article', 'used before a singular noun to refer to any one of a kind, or one not yet mentioned'],
  an: ['article', 'the form of “a” used before a vowel sound'],
  and: ['conjunction', 'used to join words, phrases or clauses that go together; also; in addition'],
  or: ['conjunction', 'used to give a choice or alternative between things'],
  but: ['conjunction', 'used to introduce something that contrasts with what was just said; however'],
  nor: ['conjunction', 'and not; used after a negative to add another negative'],
  yet: ['conjunction', 'but at the same time; nevertheless'],
  so: ['conjunction', 'and for that reason; therefore'],
  if: ['conjunction', 'on the condition that; in the event that'],
  though: ['conjunction', 'despite the fact that; although'],
  although: ['conjunction', 'in spite of the fact that'],
  because: ['conjunction', 'for the reason that; since'],
  unless: ['conjunction', 'except if; if not'],
  whether: ['conjunction', 'used to introduce a choice between alternatives, or doubt'],
  while: ['conjunction', 'during the time that; at the same time as; whereas'],
  whilst: ['conjunction', 'while (chiefly British)'],
  of: ['preposition', 'belonging to, part of, or relating to; made from; containing'],
  to: ['preposition', 'in the direction of; towards; also used before a verb to form the infinitive'],
  in: ['preposition', 'inside; within the limits of a place, time or condition'],
  on: ['preposition', 'touching and supported by the top of; about; at the time of'],
  at: ['preposition', 'used to show an exact position, point in time, or target'],
  by: ['preposition', 'beside; through the action of; not later than'],
  for: ['preposition', 'intended to be given to; in order to; on behalf of; during'],
  from: ['preposition', 'showing the point where something starts or the source it comes from'],
  with: ['preposition', 'accompanied by; having; using'],
  without: ['preposition', 'not having; not accompanied by'],
  into: ['preposition', 'to the inside of; so as to be in a particular state'],
  upon: ['preposition', 'on (more formal); immediately after'],
  unto: ['preposition', 'to (old-fashioned)'],
  towards: ['preposition', 'in the direction of; in relation to'],
  toward: ['preposition', 'in the direction of; in relation to'],
  among: ['preposition', 'surrounded by; in the company of; between more than two'],
  amongst: ['preposition', 'among'],
  between: ['preposition', 'in the space or time separating two things'],
  through: ['preposition', 'from one side or end to the other; by means of'],
  about: ['preposition', 'on the subject of; concerning; approximately'],
  against: ['preposition', 'in opposition to; touching or leaning on'],
  he: ['pronoun', 'a man, boy or male animal already mentioned'],
  she: ['pronoun', 'a woman, girl or female animal already mentioned'],
  it: ['pronoun', 'a thing or animal already mentioned or easily identified'],
  they: ['pronoun', 'people or things already mentioned; also used for one person whose gender is not known or not given'],
  them: ['pronoun', 'the object form of “they”'],
  we: ['pronoun', 'the speaker together with one or more others'],
  you: ['pronoun', 'the person or people being spoken or written to'],
  i: ['pronoun', 'the person speaking or writing'],
  me: ['pronoun', 'the object form of “I”'],
  him: ['pronoun', 'the object form of “he”'],
  her: ['pronoun', 'the object form of “she”; belonging to her'],
  his: ['pronoun', 'belonging to or associated with him'],
  its: ['pronoun', 'belonging to or associated with it'],
  their: ['pronoun', 'belonging to or associated with them'],
  our: ['pronoun', 'belonging to or associated with us'],
  your: ['pronoun', 'belonging to or associated with you'],
  my: ['pronoun', 'belonging to or associated with me'],
  thee: ['pronoun', 'you (old-fashioned, as the object of a verb)'],
  thou: ['pronoun', 'you (old-fashioned, as the subject of a verb)'],
  thy: ['pronoun', 'your (old-fashioned)'],
  thine: ['pronoun', 'yours (old-fashioned)'],
  ye: ['pronoun', 'you, plural (old-fashioned)'],
  this: ['determiner', 'the one here or just mentioned'],
  that: ['determiner', 'the one there or already mentioned; also used to introduce a clause'],
  these: ['determiner', 'plural of “this”'],
  those: ['determiner', 'plural of “that”'],
  which: ['pronoun', 'used to ask or say what one, out of a known group, is meant'],
  who: ['pronoun', 'what or which person or people'],
  whom: ['pronoun', 'the object form of “who”'],
  whose: ['pronoun', 'belonging to which person'],
  what: ['pronoun', 'asking for information about something; the thing that'],
  whatever: ['pronoun', 'anything at all that; no matter what'],
  some: ['determiner', 'an unspecified amount or number of'],
  any: ['determiner', 'one or some, no matter which'],
  every: ['determiner', 'all the individual members of a group'],
  each: ['determiner', 'every one of two or more, considered separately'],
  either: ['determiner', 'one or the other of two'],
  neither: ['determiner', 'not the one nor the other of two'],
  not: ['adverb', 'used to make a word or sentence negative'],
  no: ['determiner', 'not any; used to give a negative answer'],
  than: ['conjunction', 'used to introduce the second part of a comparison'],
  as: ['conjunction', 'in the way that; while; because; to the same degree'],
  shall: ['verb', 'used to express the future, or a strong intention or obligation'],
  should: ['verb', 'used to say what is right, expected or likely'],
  would: ['verb', 'used to talk about an imagined situation, or the past form of “will”'],
  could: ['verb', 'past form of “can”; used to say something is possible'],
  might: ['verb', 'used to say something is possible but not certain'],
  must: ['verb', 'used to say something is necessary or very likely'],
  may: ['verb', 'used to say something is possible, or to ask or give permission'],
  can: ['verb', 'to be able to; to be allowed to'],
  will: ['verb', 'used to talk about the future or to show willingness'],
  hath: ['verb', 'has (old-fashioned)'],
  doth: ['verb', 'does (old-fashioned)'],
  thus: ['adverb', 'in this way; as a result'],
  hence: ['adverb', 'as a consequence; from here or from now'],
  thence: ['adverb', 'from there; from that time'],
  whence: ['adverb', 'from where; from which'],
  hither: ['adverb', 'to or towards this place (old-fashioned)'],
  thither: ['adverb', 'to or towards that place (old-fashioned)'],
};

function functionWord(word: string): Entry | null {
  const f = FUNCTION_WORDS[word.toLowerCase()];
  if (!f) return null;
  return { word, lemma: word.toLowerCase(), groups: [{ pos: f[0], senses: [{ gloss: f[1], examples: [], synonyms: [] }] }], source: 'WordNet' };
}

export async function lookup(raw: string, lang = 'en'): Promise<Entry | null> {
  const word = clean(raw);
  if (!word) return null;
  const l = lang.split('-')[0]!.toLowerCase();
  const english = l === 'en' || !l;
  if (english || /^[a-z' -]+$/i.test(word)) {
    const hit = (await wordnet(word)) ?? functionWord(word);
    if (hit) {
      // A function word that WordNet only knows as a noun ("a" the vitamin).
      const fw = functionWord(word);
      if (fw && hit !== fw) return { ...fw, also: hit };
      return hit;
    }
  }
  if (!navigator.onLine) return null;
  return (await wiktionary(word, l)) ?? (await wikipedia(word, l));
}
