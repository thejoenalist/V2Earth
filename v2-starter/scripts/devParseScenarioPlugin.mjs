/**
 * Vite dev-only middleware: POST /api/parse-scenario
 *
 * Mirrors the Supabase edge function locally so scenario prompts work during
 * development when ANTHROPIC_API_KEY is in .env.local (never exposed to the browser).
 */

import { loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const VALID_TYPES = new Set([
  'climate_event',
  'scenario_compare',
  'region_inspect',
  'timeline_jump',
  'local_action',
  'research_query',
  'resilience_plan',
  'explain',
  'empowerment_quiz',
]);

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenceMatch ? fenceMatch[1] : text).trim();
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function devParseScenarioPlugin() {
  let anthropicKey = '';
  let systemPrompt = '';
  let enabled = false;

  return {
    name: 'dev-parse-scenario',

    async config(_, { mode }) {
      if (mode !== 'development') return;

      const env = loadEnv(mode, ROOT, '');
      anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
      if (!anthropicKey) {
        console.warn(
          '[dev-parse-scenario] ANTHROPIC_API_KEY not in .env.local — add it for local scenario parsing',
        );
        return;
      }

      const mod = await import(
        pathToFileURL(path.join(ROOT, 'src/chat/SimulationCommand.js')).href + `?t=${Date.now()}`
      );
      systemPrompt = mod.SCENARIO_PARSER_SYSTEM_PROMPT;
      enabled = true;
      console.log('[dev-parse-scenario] Local proxy ready at POST /api/parse-scenario');
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url !== '/api/parse-scenario') return next();

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        if (!enabled) {
          sendJson(res, 503, {
            error: 'Local parser unavailable — add ANTHROPIC_API_KEY to .env.local and restart the dev server',
          });
          return;
        }

        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw);
          const { query, year, ssp, history } = body ?? {};

          if (!query || typeof query !== 'string') {
            sendJson(res, 400, { error: '"query" is required and must be a string' });
            return;
          }

          const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
          const messages = safeHistory
            .filter(
              (turn) =>
                turn &&
                (turn.role === 'user' || turn.role === 'assistant') &&
                typeof turn.content === 'string',
            )
            .map((turn) => ({ role: turn.role, content: turn.content }));

          messages.push({
            role: 'user',
            content: `Current simulator context: year=${year ?? 2025}, ssp=${ssp ?? 'SSP2-4.5'}.\nUser query: ${query}`,
          });

          const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: ANTHROPIC_MODEL,
              max_tokens: 4096,
              temperature: 0.4,
              system: systemPrompt,
              messages,
            }),
          });

          if (!anthropicRes.ok) {
            const errText = await anthropicRes.text().catch(() => '');
            let detail = errText.slice(0, 300);
            try {
              detail = JSON.parse(errText).error?.message ?? detail;
            } catch {
              /* use raw text */
            }
            sendJson(res, 502, {
              error: `Anthropic API error (${anthropicRes.status}): ${detail}`,
            });
            return;
          }

          const anthropicData = await anthropicRes.json();
          const textBlock = anthropicData?.content?.find((block) => block.type === 'text');

          if (!textBlock?.text) {
            sendJson(res, 502, { error: 'No content returned by model' });
            return;
          }

          const command = JSON.parse(extractJson(textBlock.text));

          if (!command || typeof command !== 'object' || !VALID_TYPES.has(command.type)) {
            sendJson(res, 502, { error: `Invalid command type: ${command?.type}` });
            return;
          }

          sendJson(res, 200, command);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'Failed to parse scenario',
          });
        }
      });
    },
  };
}
