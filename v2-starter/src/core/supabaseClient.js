import { createClient } from '@supabase/supabase-js';

/**
 * Normalize project URL to origin only (no /rest/v1/ suffix).
 * @param {string} url
 */
export function getSupabaseOrigin(url) {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  }
}

const supabaseUrl = getSupabaseOrigin(import.meta.env.VITE_SUPABASE_URL ?? '');
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
