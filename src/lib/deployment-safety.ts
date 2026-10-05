const CANDIDATE_PROJECT_REF = 'fssogssryeunkjkdgewx';
const PRODUCTION_PROJECT_REF = 'dghozkqvxlwpjmgleekw';

function projectRef(url: string | undefined): string | null {
  try {
    const host = new URL(url || '').hostname;
    return host.endsWith('.supabase.co') ? host.slice(0, -'.supabase.co'.length) : null;
  } catch {
    return null;
  }
}

export function deploymentSafetyState(environment: string | undefined, url: string | undefined) {
  if (environment !== 'preview') return 'normal';
  const ref = projectRef(url);
  if (ref === PRODUCTION_PROJECT_REF) return 'blocked';
  return ref === CANDIDATE_PROJECT_REF ? 'preview-candidate' : 'normal';
}
