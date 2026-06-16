# parse-scenario Edge Function

Proxies chat queries from the browser to the Anthropic API. The Claude API key
never reaches the browser — it's read here from the `ANTHROPIC_API_KEY` secret.

## One-time setup

```bash
npx supabase login
npx supabase link --project-ref silryqzempbblleqaokv
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

## Deploy

```bash
npx supabase functions deploy parse-scenario
```

## Local testing

```bash
npx supabase functions serve parse-scenario --env-file .env.local
```

Then point `VITE_SUPABASE_URL` at `http://localhost:54321` while testing locally,
or just `curl` it directly:

```bash
curl -i --location --request POST 'http://localhost:54321/functions/v1/parse-scenario' \
  --header 'Authorization: Bearer YOUR_ANON_KEY' \
  --header 'Content-Type: application/json' \
  --data '{"query":"hurricane in Florida","year":2050,"ssp":"SSP2-4.5","history":[]}'
```

## Keeping the system prompt in sync

`SCENARIO_PARSER_SYSTEM_PROMPT` is duplicated at the top of `index.ts` because
Deno Edge Functions can't reliably import files from outside the `functions/`
directory at deploy time. Instead of copying it by hand, run the sync script
from the repo root whenever you edit the prompt in `src/chat/SimulationCommand.js`:

```bash
npm run sync-prompt
```

This regenerates the text between the `// SYNC:PROMPT:START` / `// SYNC:PROMPT:END`
markers in `index.ts` to match `SimulationCommand.js` exactly. Don't hand-edit
that block — it'll just get overwritten next sync. Run it before every deploy:

```bash
npm run sync-prompt
npx supabase functions deploy parse-scenario
```

## Rate limiting

The function does simple in-memory per-IP rate limiting (20 req/min). This
resets on cold start and isn't shared across instances — it's a basic abuse
deterrent, not a hard guarantee. If telemetry shows real abuse, move this to a
durable store (a Supabase table, or a service like Upstash Redis).
