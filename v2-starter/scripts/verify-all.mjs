#!/usr/bin/env node
// scripts/verify-all.mjs
//
// Automated invariant checks for Earth Simulator V2. Run before claiming any
// multi-file change is done:  npm run verify
//
// Covers the [auto] checks in handoff/skills/audit-checklist/SKILL.md:
//   1. EVENT_TYPES ↔ system prompt parity
//   2. ready-tier render strategies routed in ActiveSimulation._dispatch
//   3. sync-prompt drift (canonical prompt vs edge-function copy)
//   4. no window.* global assignments in src/
//   5. no inline ISO alpha-2→alpha-3 maps outside ISONormalizer.js
//   6. attribution.json + manifest.json presence / baked_at
//   7. support in VALID_TYPES + ChatInterface raw short-circuit
//   8. innerHTML interpolation heuristic (WARN only)
//
// Exit code 1 if any FAIL. WARNs never fail the run.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
let warnings = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL  ${m}`); };
const warn = (m) => { warnings++; console.warn(`  WARN  ${m}`); };
const section = (m) => console.log(`\n== ${m}`);

function walk(dir, exts = ['.js', '.mjs']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.includes(path.extname(name))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);

// ── Load the canonical module ────────────────────────────────────────────────
const simCmdPath = path.join(SRC, 'chat', 'SimulationCommand.js');
const mod = await import(pathToFileURL(simCmdPath).href + `?t=${Date.now()}`);
const EVENT_TYPES = mod.EVENT_TYPES;
const PROMPT = mod.SCENARIO_PARSER_SYSTEM_PROMPT;

if (!EVENT_TYPES || !PROMPT) {
  console.error('Could not import EVENT_TYPES / SCENARIO_PARSER_SYSTEM_PROMPT from SimulationCommand.js');
  process.exit(1);
}

// ── 1. EVENT_TYPES ↔ prompt parity ──────────────────────────────────────────
section('EVENT_TYPES ↔ system prompt parity');
{
  const missing = Object.keys(EVENT_TYPES).filter((k) => !PROMPT.includes(k));
  if (missing.length) fail(`events missing from SCENARIO_PARSER_SYSTEM_PROMPT: ${missing.join(', ')}`);
  else pass(`all ${Object.keys(EVENT_TYPES).length} EVENT_TYPES keys appear in the system prompt`);
}

// ── 2. ready-tier strategies routed in _dispatch ─────────────────────────────
section('ready-tier render routes');
{
  const asSource = readFileSync(path.join(SRC, 'simulation', 'ActiveSimulation.js'), 'utf8');
  const ready = Object.entries(EVENT_TYPES).filter(([, v]) => v.status === 'ready');
  const unrouted = ready.filter(([, v]) => !asSource.includes(`'${v.render}':`));
  if (unrouted.length) fail(`ready events with no _dispatch route: ${unrouted.map(([k, v]) => `${k} (${v.render})`).join(', ')}`);
  else pass(`all ${ready.length} ready-tier strategies routed in ActiveSimulation._dispatch`);
}

// ── 3. sync-prompt drift ─────────────────────────────────────────────────────
section('edge-function prompt sync');
{
  const targetPath = path.join(ROOT, 'supabase', 'functions', 'parse-scenario', 'index.ts');
  if (!existsSync(targetPath)) {
    warn(`edge function not found at ${rel(targetPath)} — skipping drift check`);
  } else {
    const targetText = readFileSync(targetPath, 'utf8');
    const START = '// SYNC:PROMPT:START';
    const END = '// SYNC:PROMPT:END';
    const s = targetText.indexOf(START);
    const e = targetText.indexOf(END);
    if (s === -1 || e === -1) {
      fail('SYNC:PROMPT markers missing from parse-scenario/index.ts');
    } else {
      // Mirror sync-prompt.mjs escaping, then compare block contents.
      const escaped = PROMPT
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
      // Normalize CRLF so Windows checkouts don't false-fail against the
      // LF string from SCENARIO_PARSER_SYSTEM_PROMPT in memory.
      const block = targetText.slice(s + START.length, e).replace(/\r\n/g, '\n');
      if (block.includes(escaped)) pass('edge-function prompt matches canonical prompt');
      else fail('edge-function prompt has DRIFTED — run: npm run sync-prompt && npx supabase functions deploy parse-scenario');
    }
  }
}

// ── 4. window.* globals ──────────────────────────────────────────────────────
section('no window.* global assignments in src/');
{
  const hits = [];
  for (const f of walk(SRC)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.split('//')[0];
      if (/window\.[A-Za-z_$][\w$]*\s*=[^=]/.test(code)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  if (hits.length) fail(`window.* assignment(s): ${hits.join(', ')}`);
  else pass('none found');
}

// ── 5. inline ISO maps outside ISONormalizer ─────────────────────────────────
section('no inline ISO alpha-2→alpha-3 maps');
{
  const hits = [];
  for (const f of walk(SRC)) {
    if (f.endsWith('ISONormalizer.js')) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/['"][A-Z]{2}['"]\s*:\s*['"][A-Z]{3}['"]/.test(line)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  if (hits.length) fail(`possible inline ISO mapping(s) — use normalizeISO(): ${hits.join(', ')}`);
  else pass('none found');
}

// ── 6. data / licensing files ────────────────────────────────────────────────
section('baked data & attribution');
{
  const attr = path.join(ROOT, 'public', 'data', 'attribution.json');
  if (!existsSync(attr)) fail('public/data/attribution.json missing (CC BY 4.0 requirement)');
  else pass('attribution.json present');

  const manifest = path.join(ROOT, 'public', 'data', 'manifest.json');
  if (!existsSync(manifest)) warn('public/data/manifest.json missing');
  else {
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      if (m.baked_at) pass(`manifest.json baked_at: ${m.baked_at}`);
      else warn('manifest.json has no baked_at timestamp');
    } catch { fail('manifest.json is not valid JSON'); }
  }
}

// ── 7. support type in VALID_TYPES (deploy-skew tripwire) ─────────────────────
section('support type registration');
{
  // Static source check — importing ScenarioParser pulls Vite import.meta.env.
  const parserSrc = readFileSync(path.join(SRC, 'chat', 'ScenarioParser.js'), 'utf8');
  const typesBlock = parserSrc.match(/export const VALID_TYPES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!typesBlock) {
    fail('export const VALID_TYPES = Object.freeze([...]) not found in ScenarioParser.js');
  } else if (!/['"]support['"]/.test(typesBlock[1])) {
    fail('VALID_TYPES missing "support" — crisis path will throw Invalid command type in prod');
  } else {
    pass('VALID_TYPES includes "support"');
  }

  const chat = readFileSync(path.join(SRC, 'chat', 'ChatInterface.js'), 'utf8');
  if (chat.includes("raw.type === 'support'") || chat.includes('raw.type === "support"')) {
    pass('ChatInterface short-circuits on raw.type === "support" before validation');
  } else {
    fail('ChatInterface missing raw.type === "support" short-circuit before validation');
  }
}

// ── 8. innerHTML interpolation heuristic ─────────────────────────────────────
section('innerHTML interpolation (heuristic)');
{
  // Known-safe sites: static trusted copy from supportMessage.js (no interpolation).
  // ChatInterface.js — _renderSupport / _renderSupportOfferFooter assign
  // SUPPORT_MESSAGE_HTML / SUPPORT_OFFER_FOOTER_HTML via innerHTML. Do not remove
  // those allowlist comments without removing the assignments.
  const chat = readFileSync(path.join(SRC, 'chat', 'ChatInterface.js'), 'utf8');
  const allowlisted = [
    'ALLOWLISTED innerHTML: static trusted copy (SUPPORT_MESSAGE_HTML)',
    'ALLOWLISTED innerHTML: static trusted copy (SUPPORT_OFFER_FOOTER_HTML)',
  ];
  for (const marker of allowlisted) {
    if (chat.includes(marker)) pass(`allowlisted support innerHTML: ${marker.match(/\(([^)]+)\)/)[1]}`);
    else fail(`missing allowlist marker for static support HTML: ${marker}`);
  }

  const hits = [];
  for (const f of walk(SRC)) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('innerHTML') || !/\$\{(?!escapeHtml)/.test(line)) return;
      // Skip if the preceding line marks an allowlisted static trusted assignment.
      const prev = lines[i - 1] ?? '';
      if (prev.includes('ALLOWLISTED innerHTML: static trusted copy')) return;
      hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  if (hits.length) warn(`innerHTML with interpolation — verify each is escaped: ${hits.join(', ')}`);
  else pass('no single-line innerHTML interpolations found (multi-line templates still need manual review)');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures} failure(s), ${warnings} warning(s).`);
if (failures) {
  console.error('verify-all: FAILED — do not report the task as complete.');
  process.exit(1);
}
console.log('verify-all: OK (manual checks in audit-checklist skill still apply).');
