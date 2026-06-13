/**
 * ScenarioParser — converts user natural language to SimulationCommand.
 *
 * Calls Claude API (claude-haiku-4-5 for speed and cost).
 * Returns a SimulationCommand that the EventSimulator and NarrativeEngine consume.
 */

import { createCommand, SCENARIO_PARSER_SYSTEM_PROMPT } from './SimulationCommand.js';
import { normalizeISO } from '../core/ISONormalizer.js';

const API_KEY = import.meta.env.VITE_CLAUDE_API_KEY ?? null;
const API_URL = 'https://api.anthropic.com/v1/messages';

export class ScenarioParser {
  /**
   * Parse a user query into a SimulationCommand.
   * @param {string} userText
   * @param {{ year: number, ssp: string }} currentContext - Current globe state
   * @returns {Promise<import('./SimulationCommand.js').SimulationCommand>}
   */
  async parse(userText, currentContext) {
    if (!API_KEY) {
      console.warn('[ScenarioParser] No VITE_CLAUDE_API_KEY — returning stub command');
      return this._stubCommand(userText);
    }

    const contextHint = `Current globe state: year=${currentContext.year}, pathway=${currentContext.ssp}`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SCENARIO_PARSER_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `${contextHint}\n\nUser query: "${userText}"` }
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`[ScenarioParser] Claude API error: ${response.status}`);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text ?? '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`[ScenarioParser] Could not parse Claude response as JSON: ${raw}`);
    }

    // Normalize ISO if present
    if (parsed.target) {
      parsed.target = normalizeISO(parsed.target) ?? parsed.target;
    }

    return createCommand(parsed);
  }

  /** Fallback when no API key is configured. */
  _stubCommand(text) {
    return createCommand({
      type: 'explain',
      target: null,
      event: null,
      params: {},
      narrative: {
        learned: `You asked: "${text}". Configure VITE_CLAUDE_API_KEY to enable live scenario parsing.`,
        action: 'Add your Claude API key to .env.local as VITE_CLAUDE_API_KEY.',
        emotion: '',
        sources: [],
      },
    });
  }
}
