import { mockDbAdapter } from './mock';
import { supabaseDbAdapter } from './supabase';

// Check for Supabase environment variables. If missing, automatically fall back to mock.
const hasSupabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const dbAdapter = hasSupabase ? supabaseDbAdapter : mockDbAdapter;
