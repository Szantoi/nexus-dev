#!/usr/bin/env node
/**
 * check-doc-links.mjs — dokumentációs linkellenőrző (TASK-QC-002)
 *
 * Ellenőrzi:
 *   1. a docs/ alatti markdown-fájlok LOKÁLIS linkjeit (léteznek-e a célfájlok),
 *   2. a forráskönyvtárakban található "docs/architecture/decisions/<fájl>"
 *      útvonal-hivatkozásokat (kommentben, markdownban),
 *   3. a forráskönyvtárakban található "ADR-NNN" említéseket: létezik-e
 *      ADR-NNN-*.md a decisions-könyvtárban.
 *
 * Node-only, külső függőség nélkül. Törött hivatkozásnál exit code 1.
 *
 * Használat (repo-gyökérből):
 *   node scripts/check-doc-links.mjs
 *   node scripts/check-doc-links.mjs --docs docs --src knowledge-service/src --quiet
 *
 * Paraméterek:
 *   --root <dir>       repo-gyökér (default: a script szülőkönyvtárának szülője)
 *   --docs <dir>       markdown-linkek ellenőrzésének gyökere, ismételhető (default: docs)
 *   --src <dir>        ADR-hivatkozások keresési gyökere, ismételhető
 *                      (default: knowledge-service/src)
 *   --decisions <dir>  ADR-könyvtár (default: docs/architecture/decisions)
 *   --no-adr-scan      a 2-3. ellenőrzés kihagyása (csak markdown-linkek)
 *   --quiet            csak a hibák kiírása
 *   --help             súgó
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Argumentum-feldolgozás ─────────────────────────────────────────────────

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaults = {
  root: resolve(scriptDir, '..'),
  docs: [],
  src: [],
  decisions: 'docs/architecture/decisions',
  adrScan: true,
  quiet: false,
};

const args = process.argv.slice(2);
const opts = { ...defaults };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case '--root': opts.root = resolve(args[++i]); break;
    case '--docs': opts.docs.push(args[++i]); break;
    case '--src': opts.src.push(args[++i]); break;
    case '--decisions': opts.decisions = args[++i]; break;
    case '--no-adr-scan': opts.adrScan = false; break;
    case '--quiet': opts.quiet = true; break;
    case '--help':
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/');
      process.exit(0);
      break;
    default:
      console.error(`Ismeretlen paraméter: ${a} (lásd --help)`);
      process.exit(2);
  }
}
if (opts.docs.length === 0) opts.docs = ['docs'];
if (opts.src.length === 0) opts.src = ['knowledge-service/src'];

const ROOT = opts.root;
const DECISIONS_DIR = resolve(ROOT, opts.decisions);
const log = (...m) => { if (!opts.quiet) console.log(...m); };

// ─── Segédek ────────────────────────────────────────────────────────────────

/** Rekurzív fájllista, node_modules/.git kihagyásával. */
function walk(dir, exts) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

const rel = (p) => p.slice(ROOT.length + 1).replaceAll('\\', '/');
const broken = []; // { file, line, target, kind }

// ─── 1. Markdown lokális linkek a docs-gyökerek alatt ───────────────────────

let mdLinkCount = 0;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const docsDir of opts.docs) {
  const base = resolve(ROOT, docsDir);
  if (!existsSync(base)) {
    console.error(`HIBA: a docs-gyökér nem létezik: ${docsDir}`);
    process.exit(2);
  }
  for (const file of walk(base, ['.md'])) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((lineText, idx) => {
      for (const m of lineText.matchAll(LINK_RE)) {
        const raw = m[1];
        // Külső linkek, mailto, horgony-only linkek kihagyása
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
        mdLinkCount++;
        const targetPath = raw.split('#')[0].split('?')[0];
        if (targetPath === '') continue; // csak horgony
        const abs = isAbsolute(targetPath)
          ? targetPath
          : resolve(dirname(file), decodeURIComponent(targetPath));
        if (!existsSync(abs)) {
          broken.push({ file: rel(file), line: idx + 1, target: raw, kind: 'md-link' });
        }
      }
    });
  }
}

// ─── 2-3. ADR-hivatkozások a forráskönyvtárakban ────────────────────────────

let pathRefCount = 0;
let adrRefCount = 0;

if (opts.adrScan) {
  // A decisions-könyvtár ADR-számainak halmaza (ADR-NNN-*.md fájlnevekből)
  const adrFiles = existsSync(DECISIONS_DIR)
    ? readdirSync(DECISIONS_DIR).filter((f) => /^ADR-\d+.*\.md$/i.test(f))
    : [];
  const adrNumbers = new Set(adrFiles.map((f) => f.match(/^ADR-(\d+)/i)[1]));

  const PATH_RE = /docs\/architecture\/decisions\/([A-Za-z0-9._-]+\.md)/g;
  const ADR_RE = /\bADR-(\d{1,4})\b/g;
  const srcExts = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.yaml', '.yml'];

  for (const srcDir of opts.src) {
    const base = resolve(ROOT, srcDir);
    if (!existsSync(base)) {
      console.error(`HIBA: a forrás-gyökér nem létezik: ${srcDir}`);
      process.exit(2);
    }
    for (const file of walk(base, srcExts)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((lineText, idx) => {
        // 2. explicit útvonal-hivatkozások
        for (const m of lineText.matchAll(PATH_RE)) {
          pathRefCount++;
          if (!existsSync(join(DECISIONS_DIR, m[1]))) {
            broken.push({ file: rel(file), line: idx + 1, target: m[0], kind: 'adr-path' });
          }
        }
        // 3. csupasz ADR-NNN említések → ADR-NNN-*.md létezés
        for (const m of lineText.matchAll(ADR_RE)) {
          adrRefCount++;
          if (!adrNumbers.has(m[1])) {
            broken.push({
              file: rel(file), line: idx + 1, target: `ADR-${m[1]}`, kind: 'adr-number',
            });
          }
        }
      });
    }
  }
}

// ─── Riport ─────────────────────────────────────────────────────────────────

log(`Ellenőrizve: ${mdLinkCount} markdown-link (${opts.docs.join(', ')}), ` +
  `${pathRefCount} ADR-útvonal-hivatkozás, ${adrRefCount} ADR-szám-említés ` +
  `(${opts.src.join(', ')})`);

if (broken.length > 0) {
  console.error(`\nTÖRÖTT HIVATKOZÁSOK (${broken.length}):`);
  for (const b of broken) {
    console.error(`  [${b.kind}] ${b.file}:${b.line} → ${b.target}`);
  }
  process.exit(1);
}

log('OK — minden hivatkozás létező célra mutat.');
process.exit(0);
