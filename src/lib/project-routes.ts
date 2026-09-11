export type ProjectsRoute =
  | { kind: 'all'; memberId: null; isLegacy: false }
  | { kind: 'active'; memberId: null; isLegacy: false }
  | { kind: 'member'; memberId: string; isLegacy: boolean }
  | { kind: 'invalid'; memberId: null; isLegacy: false };

export function buildMemberProjectsHref(memberId: string): string {
  return `/projects/member/${encodeURIComponent(memberId)}`;
}

export function parseProjectsRoute(filter: string | string[] | undefined): ProjectsRoute {
  const segments = (Array.isArray(filter) ? filter : filter ? [filter] : [])
    .map(segment => segment.trim())
    .filter(Boolean);

  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'all')) {
    return { kind: 'all', memberId: null, isLegacy: false };
  }
  if (segments.length === 1 && segments[0] === 'active') {
    return { kind: 'active', memberId: null, isLegacy: false };
  }
  if (segments.length === 2 && segments[0] === 'member') {
    return { kind: 'member', memberId: segments[1], isLegacy: false };
  }
  if (segments.length === 1) {
    return { kind: 'member', memberId: segments[0], isLegacy: true };
  }
  return { kind: 'invalid', memberId: null, isLegacy: false };
}
