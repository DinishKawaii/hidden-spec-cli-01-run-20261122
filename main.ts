// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool-call edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. SPEC.md is the whole
// contract. Node 22, the standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the patch cannot be read in its format, at line `line`. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** A failed edit: `code` on the file `path`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no
 *  empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`,
 *  and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file's lines, its line break, and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the
 *  rest read from disk. Moves a move edit performed, for the `R` output line. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier sees it: tier 0 exact, tier 1 trailing whitespace gone,
 *  tier 2 leading and trailing whitespace gone. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `lines` at `tier`; occurrences may
 *  overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => tierLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2, or only 0 when strict) at which O occurs in the
 *  file's lines at least once, with its occurrences; null when it occurs at
 *  no tier. */
function firstTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of the new text: a context line (written as the file's own matched
 *  line) or a fresh line. `oIndex` is the context line's index inside O. */
interface NewLine {
  ctx: boolean;
  text: string;
  oIndex: number;
}

/** Build the lines that replace O's occurrence at `at`, in the file's lines:
 *  context lines as the file wrote them, fresh lines re-indented at tier 2. */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(o[0]!);
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[at + item.oIndex]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The old and new line lists of one hunk or chunk body, plus whether a `\`
 *  line follows the body's last context or `+` line. */
function bodyParts(body: BodyLine[]): { o: string[]; n: NewLine[]; noFinal: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ ctx: true, text: b.text, oIndex: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ ctx: false, text: b.text, oIndex: -1 });
    }
  }
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  }
  const noFinal = last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
  return { o, n, noFinal };
}

/** One body line of a hunk or chunk: ' ' context, '-' old, '+' new, '\' the
 *  no-newline marker. `raw` is the patch line it came from. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

function toBodyLine(line: string): BodyLine {
  if (line === '') return { kind: ' ', text: '', raw: line };
  return { kind: line[0] as ' ' | '-' | '+' | '\\', text: line.slice(1), raw: line };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function freshSection(): Section {
  return {
    oldPath: null,
    newPath: null,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path of a `--- ` or `+++ ` header line: after the four characters, up
 *  to the first tab, surrounding spaces removed, one leading `a/` or `b/`
 *  removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks in order to a file's text, returning the new text.
 *  `path` names the file a hunk failure reports. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, noFinal } = bodyParts(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      const add = n.map((item) => item.text);
      f.lines.splice(at, 0, ...add);
      if (atEnd) f.final = !noFinal;
      d += n.length;
      continue;
    }
    const found = firstTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === f.lines.length;
    const rep = buildReplacement(f.lines, best, o, n, found.tier);
    f.lines.splice(best, o.length, ...rep);
    if (atEnd) f.final = !noFinal;
    d += n.length - o.length;
  }
  return joinFile(f);
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.diffOld ?? '';
  const newP = s.newPath ?? s.renameTo ?? s.diffNew ?? '';
  const isCreate = oldP === '/dev/null' || s.newFile;
  const isDelete = newP === '/dev/null' || s.deletedFile;
  const isMove = !isCreate && !isDelete && oldP !== newP;
  if (isCreate) {
    return (tree) => {
      checkSafe(newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noFinal = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = s.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k -= 1) {
          if (body[k]!.kind === '+') {
            noFinal = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if (isDelete) {
    return (tree) => {
      checkSafe(oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
    };
  }
  if (isMove) {
    return (tree) => {
      checkSafe(oldP);
      checkSafe(newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, s.hunks, strict, oldP);
      tree.set(oldP, null);
      tree.set(newP, result);
      tree.recordMove(oldP, newP);
    };
  }
  return (tree) => {
    checkSafe(oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.set(oldP, applyHunks(before, s.hunks, strict, oldP));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      const s = freshSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      sections.push(s);
      cur = s;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && cur.oldPath === null && cur.newPath === null) {
        cur.oldPath = oldP;
        cur.newPath = newP;
      } else {
        const s = freshSection();
        s.oldPath = oldP;
        s.newPath = newP;
        sections.push(s);
        cur = s;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      if (cur === null) throw new ParseErr(i + 1);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          hunk.body.push(toBodyLine(bl));
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => sectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ ctx: false, text: t, oIndex: -1 }));
    const rep = buildReplacement(f.lines, at, oldLines, n, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(searchNo);
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseErr(searchNo);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseErr(searchNo);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function updateEdit(path: string, raw: string[], baseNo: number, updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let seenChunk = false;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; k < raw.length; k += 1) {
    const l = raw[k]!;
    const lineNo = baseNo + k;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new ParseErr(lineNo);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!seenChunk) {
          cur = { anchor: null, eof: false, body: [] };
          seenChunk = true;
        } else throw new ParseErr(lineNo);
      }
      cur.body.push(toBodyLine(l));
      continue;
    }
    throw new ParseErr(lineNo);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLineNo);
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const t of tiers) {
          for (let idx = cursor; idx < f.lines.length; idx += 1) {
            if (tierLine(f.lines[idx]!, t) === tierLine(chunk.anchor, t)) {
              found = idx;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = bodyParts(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const add = n.map((item) => item.text);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let tier = -1;
      let occ: number[] = [];
      for (const t of tiers) {
        occ = occurrences(f.lines, o, t).filter((p) => p >= cursor);
        if (chunk.eof) occ = occ.filter((p) => p + o.length === f.lines.length);
        if (occ.length > 0) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', path);
      const at = occ[0]!;
      const rep = buildReplacement(f.lines, at, o, n, tier);
      f.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, result);
      tree.recordMove(path, moveTo);
    } else {
      tree.set(path, result);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDelete = line.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const lineNo = i + 1;
      i += 1;
      const start = i;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (isAdd) {
        const fileLines: string[] = [];
        for (let r = 0; r < raw.length; r += 1) {
          const l = raw[r]!;
          if (l.startsWith('+')) fileLines.push(l.slice(1));
          else if (l === '') fileLines.push('');
          else throw new ParseErr(start + r + 1);
        }
        edits.push(((p: string, fl: string[]): Edit => (tree) => {
          checkSafe(p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
        })(path, fileLines));
      } else if (isDelete) {
        for (let r = 0; r < raw.length; r += 1) {
          if (!blank(raw[r]!)) throw new ParseErr(start + r + 1);
        }
        edits.push(((p: string): Edit => (tree) => {
          checkSafe(p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.set(p, null);
        })(path));
      } else {
        edits.push(updateEdit(path, raw, start + 1, lineNo, strict));
      }
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4), the command line (section 1), and     */
/* output, exit codes, order and atomicity (sections 2 and 10)         */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      covered.add(oldP);
      covered.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
