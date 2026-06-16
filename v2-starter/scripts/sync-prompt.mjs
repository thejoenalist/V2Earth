#!/usr/bin/env node
// scripts/sync-prompt.mjs
//
// SCENARIO_PARSER_SYSTEM_PROMPT lives in one canonical place — src/chat/SimulationCommand.js.
// Deno Edge Functions can't reliably import files from outside the supabase/functions/
// directory at deploy time, so the prompt is duplicated as plain text inside
// supabase/functions/parse-scenario/index.ts. This script keeps that duplicate honest:
// it imports the real SimulationCommand.js module (so it gets the actual evaluated
// string, not a regex guess at the source text) and overwrites the block between the
// `// SYNC:PROMPT:START` / `// SYNC:PROMPT:END` markers in index.ts to match exactly.
//
// Run this after editing the prompt in SimulationCommand.js, before deploying:
//   npm run sync-prompt
//   npx supabase functions deploy parse-scenario

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'src', 'chat', 'SimulationCommand.js');
const TARGET_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'parse-scenario', 'index.ts');

const START_MARKER = '// SYNC:PROMPT:START';
const END_MARKER = '// SYNC:PROMPT:END';

function fail(message) {
  console.error(`[sync-prompt] ${message}`);
  process.exit(1);
}

// Import the real module to get the actual runtime string value (already .trim()'d
// by the module itself). Deliberately NOT regex-scraping the source text between
// backticks — that text already contains escape sequences (\` , \${) written for
// the source file's own template literal, and re-escaping those by regex double-
// escapes them. Importing gives us the true value once, with no guessing.
const cacheBust = `?t=${Date.now()}`; // bypass Node's ESM module cache on repeated runs
let mod;
try {
  mod = await import(pathToFileURL(SOURCE_PATH).href + cacheBust);
} catch (err) {
  fail(`Failed to import ${SOURCE_PATH}: ${err.message}`);
}

const promptValue = mod.SCENARIO_PARSER_SYSTEM_PROMPT;
if (typeof promptValue !== 'string' || !promptValue.trim()) {
  fail(`SimulationCommand.js did not export a non-empty SCENARIO_PARSER_SYSTEM_PROMPT string.`);
}

// Escape so this runtime value can be re-embedded as a fresh template literal in index.ts.
const escapedPrompt = promptValue
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

let targetText;
try {
  targetText = readFileSync(TARGET_PATH, 'utf8');
} catch (err) {
  fail(`Failed to read ${TARGET_PATH}: ${err.message}`);
}

const usesCrlf = targetText.includes('\r\n');
const startIdx = targetText.indexOf(START_MARKER);
const endIdx = targetText.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  fail(
    `Could not find both "${START_MARKER}" and "${END_MARKER}" markers (in order) in ${TARGET_PATH}. ` +
      'Has the file structure changed?'
  );
}

const before = targetText.slice(0, startIdx);
const after = targetText.slice(endIdx + END_MARKER.length);

const block =
  `${START_MARKER}\n` +
  `const SCENARIO_PARSER_SYSTEM_PROMPT = \`${escapedPrompt}\`.trim();\n` +
  `${END_MARKER}`;

let newTargetText = `${before}${block}${after}`;

if (usesCrlf) {
  // Normalize first in case the block we built has bare \n, then convert wholesale.
  newTargetText = newTargetText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

if (newTargetText === targetText) {
  console.log('[sync-prompt] index.ts is already up to date — no changes written.');
  process.exit(0);
}

writeFileSync(TARGET_PATH, newTargetText, 'utf8');
console.log(`[sync-prompt] Synced SCENARIO_PARSER_SYSTEM_PROMPT into ${path.relative(process.cwd(), TARGET_PATH)}`);
