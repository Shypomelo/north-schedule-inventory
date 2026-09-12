const PRODUCTION_PROJECT_REF = 'dghozkqvxlwpjmgleekw';
const CANDIDATE_PROJECT_REF = 'fssogssryeunkjkdgewx';

const extractProjectRef = (url?: string) => {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.slice(0, -'.supabase.co'.length) : null;
  } catch {
    return null;
  }
};

const explicitlyDisabled = () => {
  const value = process.env.DISABLE_EXTERNAL_SIDE_EFFECTS?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

export const getExternalSideEffectGuard = () => {
  const projectRef = extractProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const disabled = explicitlyDisabled() || projectRef !== PRODUCTION_PROJECT_REF;

  return {
    disabled,
    projectRef,
    candidate: projectRef === CANDIDATE_PROJECT_REF,
    reason: disabled ? 'external_side_effects_disabled' as const : null,
  };
};

