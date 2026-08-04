#!/usr/bin/env node
// scripts/verify-ship.mjs
//
// Ship gate: static invariants + deploy-skew markers + MANUAL-CHECKS freshness.
// Exit 0 clean / 1 on any failure. One PASS/FAIL line per check.
//
// Usage:  node scripts/verify-ship.mjs
//         npm run verify-ship   (also runs verify-support.mjs)
// Env:    SHIP_URL (default https://joenalism.netlify.app)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..');
const SHIP_URL = (process.env.SHIP_URL || 'https://joenalism.netlify.app').replace(/\/$/, '');
const EXPECTED_TS7006 = 7;
const MANUAL_MAX_AGE_DAYS = 90;

const MANUAL_CHECK_IDS = [
  'rls-on',
  'anon-insert',
  'admin-policy',
  'signup-disabled',
  'anthropic-ceiling',
  'cesium-token',
];

/** Every HTML sink in src/ + admin/ must match one entry (file + line substring). */
const HTML_SINK_ALLOWLIST = [
  { file: 'src/chat/ChatInterface.js', includes: 'el.innerHTML = SUPPORT_MESSAGE_HTML' },
  { file: 'src/chat/ChatInterface.js', includes: 'el.innerHTML = SUPPORT_OFFER_FOOTER_HTML' },
  { file: 'src/chat/ChatInterface.js', includes: "questionEl.innerHTML = ''" },
  { file: 'src/chat/ChatInterface.js', includes: 'card.innerHTML = `' },
];

const DEPLOY_MARKERS = [
  { id: 'support:shown', needle: 'support:shown' },
  { id: 'findahelpline.com', needle: 'findahelpline.com' },
  { id: 'VALID_TYPES support', needle: 'empowerment_quiz","support' },
];

const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', '.cursor', 'terminals', 'agent-transcripts',
]);

let failures = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { failures++; console.error(`FAIL  ${m}`); };

function walk(dir, exts = null) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (!exts || exts.includes(path.extname(name))) out.push(p);
  }
  return out;
}

function rel(p, root = ROOT) {
  return path.relative(root, p).split(path.sep).join('/');
}

function read(p) {
  return readFileSync(p, 'utf8');
}

/** Strip // comments without treating URL :// as a comment start. */
function stripComments(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') break;
    out += c;
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: 'text/html,*/*' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function pickBundleUrl(html) {
  const matches = [...html.matchAll(/\/assets\/[^"'>\s]+\.js/g)].map((m) => m[0]);
  return matches.find((u) => /\/assets\/index-[^/]+\.js$/.test(u)) || matches[0] || null;
}

// ── 1. Secrets absent from dist/ ─────────────────────────────────────────────
{
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(dist)) {
    fail('dist/ missing — run npm run build before verify-ship');
  } else {
    const needles = ['ANTHROPIC_API_KEY', 'service_role', 'sk-ant'];
    const hits = [];
    for (const f of walk(dist)) {
      let text;
      try { text = read(f); } catch { continue; }
      for (const n of needles) {
        if (text.includes(n)) hits.push(`${rel(f)}:${n}`);
      }
    }
    if (hits.length) fail(`secret-like string(s) in dist/: ${hits.join(', ')}`);
    else pass('no ANTHROPIC_API_KEY / service_role / sk-ant in dist/');
  }
}

// ── 2. No legacy Netlify subdomain references anywhere in the repo ───────────
{
  // Split so this script file never contains the banned hostname literal.
  const banned = ('chipper' + '-faun').toLowerCase();
  const hits = [];
  for (const root of [ROOT, REPO_ROOT]) {
    for (const f of walk(root, ['.md', '.html', '.js', '.mjs', '.ts', '.json', '.toml', '.yml', '.yaml', '.txt', '.css'])) {
      if (root === REPO_ROOT && f.startsWith(ROOT + path.sep)) continue;
      let text;
      try { text = read(f); } catch { continue; }
      if (text.toLowerCase().includes(banned)) hits.push(rel(f, root === ROOT ? ROOT : REPO_ROOT));
    }
  }
  const uniq = [...new Set(hits)];
  if (uniq.length) fail(`legacy hostname reference(s) (${banned}*): ${uniq.join(', ')}`);
  else pass('no legacy chipper hostname reference in repo');
}

// ── 3–5. _headers security ───────────────────────────────────────────────────
{
  const headersPath = path.join(ROOT, 'public', '_headers');
  if (!existsSync(headersPath)) {
    fail('public/_headers missing');
  } else {
    const h = read(headersPath);
    const required = [
      ['Strict-Transport-Security', /strict-transport-security/i],
      ['Permissions-Policy', /permissions-policy/i],
      ['X-Frame-Options', /x-frame-options/i],
      ['X-Content-Type-Options: nosniff', /x-content-type-options\s*:\s*nosniff/i],
      ['Referrer-Policy', /referrer-policy/i],
    ];
    for (const [label, re] of required) {
      if (re.test(h)) pass(`_headers has ${label}`);
      else fail(`_headers missing ${label}`);
    }
    if (/connect-src[^;]*api\.anthropic\.com/i.test(h)) {
      fail('_headers connect-src must NOT contain api.anthropic.com');
    } else {
      pass('_headers connect-src does not contain api.anthropic.com');
    }
  }
}

// ── 6. No runtime CDN imports in admin/ ──────────────────────────────────────
{
  const adminDir = path.join(ROOT, 'admin');
  const cdnRe = /https?:\/\/(esm\.sh|cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com)/i;
  const hits = [];
  for (const f of walk(adminDir, ['.html', '.js', '.mjs'])) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      const code = stripComments(line);
      if (cdnRe.test(code) && /\bimport\b|\bsrc\s*=|\bhref\s*=/.test(code)) {
        hits.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  if (hits.length) fail(`runtime CDN import(s) in admin/: ${hits.join(', ')}`);
  else pass('no esm.sh / CDN runtime imports in admin/');
}

// ── 7. No import.meta.env in parse-scenario ───────────────────────────────────
{
  const edge = path.join(ROOT, 'supabase', 'functions', 'parse-scenario', 'index.ts');
  if (!existsSync(edge)) fail('parse-scenario/index.ts missing');
  else if (read(edge).includes('import.meta.env')) fail('parse-scenario/index.ts contains import.meta.env');
  else pass('parse-scenario/index.ts has no import.meta.env');
}

// ── 8. deno check — exactly 7× TS7006, zero other errors ─────────────────────
{
  const edgeRel = 'supabase/functions/parse-scenario/index.ts';
  // Windows: spawn npx/deno via shell so PATH resolution works (spawnSync npx.cmd → EINVAL).
  const cmd = `npx --yes deno check "${edgeRel}"`;
  const result = spawnSync(cmd, {
    encoding: 'utf8',
    cwd: ROOT,
    shell: true,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error && result.error.code === 'ENOENT') {
    fail('deno check: shell/npx not available');
  } else {
    const ts7006 = (out.match(/TS7006/g) || []).length;
    const otherCodes = [...out.matchAll(/TS(\d{4})/g)]
      .map((m) => m[1])
      .filter((c) => c !== '7006');
    const otherUnique = [...new Set(otherCodes)];

    if (ts7006 === EXPECTED_TS7006 && otherUnique.length === 0) {
      pass(`deno check: exactly ${EXPECTED_TS7006} TS7006, zero others`);
    } else {
      fail(
        `deno check: expected ${EXPECTED_TS7006} TS7006 and 0 others; got TS7006=${ts7006}`
        + (otherUnique.length ? ` others=TS${otherUnique.join(',TS')}` : ''),
      );
    }
  }
}

// ── 9. HTML sinks allowlist ──────────────────────────────────────────────────
{
  const sinkRe = /\.innerHTML\b|\.outerHTML\b|\.insertAdjacentHTML\b|document\.write\b/;
  const found = [];
  for (const dir of ['src', 'admin'].map((d) => path.join(ROOT, d))) {
    for (const f of walk(dir, ['.js', '.mjs', '.html'])) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        const code = stripComments(line);
        if (!sinkRe.test(code)) return;
        // Skip comment-only / string-in-comment already stripped; skip JSDoc mentions
        if (!/[=\.]/.test(code) && !code.includes('insertAdjacentHTML') && !code.includes('document.write')) return;
        // Require an actual call/assignment shape
        if (
          !/\.innerHTML\s*=/.test(code)
          && !/\.outerHTML\s*=/.test(code)
          && !/\.insertAdjacentHTML\s*\(/.test(code)
          && !/document\.write\s*\(/.test(code)
        ) return;
        found.push({ file: rel(f), line: i + 1, text: line.trim() });
      });
    }
  }

  const unmatched = [];
  for (const hit of found) {
    const ok = HTML_SINK_ALLOWLIST.some(
      (a) => hit.file === a.file && hit.text.includes(a.includes),
    );
    if (!ok) unmatched.push(`${hit.file}:${hit.line} ${hit.text.slice(0, 80)}`);
  }
  // Also fail if allowlist entries disappeared
  for (const a of HTML_SINK_ALLOWLIST) {
    const abs = path.join(ROOT, a.file);
    if (!existsSync(abs) || !read(abs).includes(a.includes)) {
      unmatched.push(`allowlist entry missing: ${a.file} → ${a.includes}`);
    }
  }
  if (unmatched.length) fail(`HTML sink not allowlisted (or missing): ${unmatched.join(' | ')}`);
  else pass(`HTML sinks allowlisted (${HTML_SINK_ALLOWLIST.length} sites)`);
}

// ── 10. ExportService disclaimer on every export path ────────────────────────
{
  const es = path.join(ROOT, 'src', 'export', 'ExportService.js');
  if (!existsSync(es)) {
    fail('ExportService.js missing');
  } else {
    const text = read(es);
    const hasBuilder = /function buildDisclaimerHtml\s*\(/.test(text);
    const wrapCallsDisclaimer = text.includes('const disclaimer = buildDisclaimerHtml(generated)');
    const methods = ['_buildEmpowermentDoc', '_buildResiliencePlanDoc', '_buildGenericDoc'];
    const missingDefs = methods.filter((name) => !new RegExp(`^\\s+${name}\\s*\\(`, 'm').test(text));
    // Every builder returns this._wrap({...}) — count definition-site returns.
    const wrapReturns = (text.match(/return\s+this\._wrap\s*\(/g) || []).length;
    if (!hasBuilder) fail('ExportService missing buildDisclaimerHtml');
    else if (!wrapCallsDisclaimer) fail('ExportService._wrap does not call buildDisclaimerHtml');
    else if (missingDefs.length) fail(`export builder(s) missing: ${missingDefs.join(', ')}`);
    else if (wrapReturns < methods.length) {
      fail(`ExportService: expected ≥${methods.length} return this._wrap(, found ${wrapReturns}`);
    } else pass('ExportService disclaimer via _wrap on every export path');
  }
}

// ── 11. Viability fields are not consumed as booleans ────────────────────────
{
  const bad = [];
  const re = /\.(profitable|sustainable|viable)\s*===?\s*(true|false)\b/;
  for (const f of walk(path.join(ROOT, 'src'), ['.js', '.mjs'])) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (re.test(stripComments(line))) bad.push(`${rel(f)}:${i + 1}`);
    });
  }
  if (bad.length) fail(`viability boolean compare(s): ${bad.join(', ')}`);
  else pass('no .profitable/.sustainable/.viable boolean comparisons');
}

// ── 12. VALID_TYPES includes support ─────────────────────────────────────────
{
  const parser = path.join(ROOT, 'src', 'chat', 'ScenarioParser.js');
  const text = read(parser);
  const block = text.match(/export const VALID_TYPES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!block) fail('VALID_TYPES export not found in ScenarioParser.js');
  else if (!/['"]support['"]/.test(block[1])) fail('VALID_TYPES missing "support"');
  else pass('VALID_TYPES includes "support"');
}

// ── 13. MANUAL-CHECKS.md freshness ───────────────────────────────────────────
{
  const manualPath = path.join(ROOT, 'MANUAL-CHECKS.md');
  if (!existsSync(manualPath)) {
    fail('MANUAL-CHECKS.md missing');
  } else {
    const text = read(manualPath);
    const now = Date.now();
    const maxAgeMs = MANUAL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const id of MANUAL_CHECK_IDS) {
      const row = text.match(new RegExp(`\\|\\s*${id}\\s*\\|[^|]+\\|\\s*(\\d{4}-\\d{2}-\\d{2})\\s*\\|`));
      if (!row) {
        fail(`MANUAL-CHECKS.md missing date for ${id}`);
        continue;
      }
      const t = Date.parse(row[1] + 'T00:00:00Z');
      if (Number.isNaN(t)) fail(`MANUAL-CHECKS.md bad date for ${id}: ${row[1]}`);
      else if (now - t > maxAgeMs) fail(`MANUAL-CHECKS.md ${id} stale (${row[1]}, >${MANUAL_MAX_AGE_DAYS}d)`);
      else pass(`MANUAL-CHECKS.md ${id} verified ${row[1]}`);
    }
  }
}

// ── 14. Deploy skew ──────────────────────────────────────────────────────────
{
  // Local source must contain markers; deployed bundle must contain them too.
  const localJoined = walk(path.join(ROOT, 'src'), ['.js', '.mjs'])
    .map((f) => read(f))
    .join('\n');

  // VALID_TYPES support marker: empowerment_quiz","support in source (double or single quotes)
  const localHasValidSupport = /['"]empowerment_quiz['"]\s*,\s*['"]support['"]/.test(localJoined)
    || /['"]support['"]/.test(
      (read(path.join(ROOT, 'src', 'chat', 'ScenarioParser.js')).match(
        /export const VALID_TYPES = Object\.freeze\(\[([\s\S]*?)\]\)/,
      ) || [])[1] || '',
    );

  const markers = [
    { id: 'support:shown', needle: 'support:shown', localOk: localJoined.includes('support:shown') },
    { id: 'findahelpline.com', needle: 'findahelpline.com', localOk: localJoined.includes('findahelpline.com') },
    {
      id: 'VALID_TYPES support',
      needle: null, // special
      localOk: localHasValidSupport,
      bundleHas: (b) => /empowerment_quiz["'],\s*["']support["']/.test(b)
        || /empowerment_quiz","support/.test(b)
        || /empowerment_quiz','support/.test(b)
        // Minifiers may emit array form with support as own string near quiz
        || (b.includes('empowerment_quiz') && /["']support["']/.test(b) && b.includes('support:shown')),
    },
  ];

  for (const m of markers) {
    if (!m.localOk) fail(`deploy-skew: local source missing ${m.id}`);
  }

  try {
    const html = await fetchText(`${SHIP_URL}/`);
    const assetPath = pickBundleUrl(html);
    if (!assetPath) {
      fail('deploy-skew: no /assets/*.js in production index.html');
    } else {
      const bundleUrl = assetPath.startsWith('http') ? assetPath : `${SHIP_URL}${assetPath}`;
      const bundle = await fetchText(bundleUrl);
      for (const m of markers) {
        if (!m.localOk) continue;
        const ok = m.bundleHas
          ? m.bundleHas(bundle)
          : bundle.includes(m.needle);
        if (ok) pass(`deploy-skew: bundle has ${m.id}`);
        else fail(`deploy-skew: local has ${m.id} but deployed bundle does not`);
      }
    }
  } catch (err) {
    fail(`deploy-skew fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${failures} failure(s).`);
if (failures) {
  console.error('verify-ship: FAILED');
  process.exit(1);
}
console.log('verify-ship: OK');
