#!/usr/bin/env node
// Runs verify-ship then verify-support; always runs both; exits 1 if either fails.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
let code = 0;
for (const script of ['verify-ship.mjs', 'verify-support.mjs']) {
  const r = spawnSync(node, [path.join(__dirname, script)], { stdio: 'inherit' });
  if (r.status) code = r.status;
}
process.exit(code);
