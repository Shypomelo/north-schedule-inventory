import type { UserRole } from './db/types';

export const isStandardAppRole = (role?: string | null) =>
  role === 'ADMIN' || role === 'ENGINEER' || role === 'VIEWER';

export const isInventoryEditor = (role?: UserRole | null) =>
  role === 'ADMIN' || role === 'ENGINEER';

export const isProcurementRoute = (path: string) =>
  path === '/inventory' || path.startsWith('/inventory/') ||
  path === '/receiving' || path.startsWith('/receiving/');

export const landingPath = (role?: UserRole | null) =>
  role === 'PROCUREMENT' ? '/inventory' : '/';
