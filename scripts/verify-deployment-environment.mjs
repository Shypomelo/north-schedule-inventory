import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const targets = {
  preview: {
    ref: 'fssogssryeunkjkdgewx',
    error: 'PREVIEW_SUPABASE_TARGET_MISMATCH',
  },
  production: {
    ref: 'dghozkqvxlwpjmgleekw',
    error: 'PRODUCTION_SUPABASE_TARGET_MISMATCH',
  },
};

export function deploymentEnvironmentError(environment, url) {
  const target = targets[environment];
  if (!target) return null;
  let host;
  try {
    host = new URL(url || '').hostname;
  } catch {
    // A missing or malformed URL is a mismatch; never print its value.
  }

  if (host !== `${target.ref}.supabase.co`) {
    return target.error;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const error = deploymentEnvironmentError(process.env.VERCEL_ENV, process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (error) {
    console.error(`${error}: ${process.env.VERCEL_ENV} requires its assigned Supabase project.`);
    process.exit(1);
  }
}
