import { dbAdapter } from '@/lib/db';
import type { Todo, User } from '@/lib/db/types';

export function canCreateTodo(actor: User | null): actor is User {
  return Boolean(actor && actor.role !== 'VIEWER');
}

export async function createCanonicalPrivateTodo(
  title: string,
  actor: User | null,
): Promise<Todo | null> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle || !canCreateTodo(actor)) return null;
  return dbAdapter.createPrivateTodo({
    title: normalizedTitle,
    created_by: actor.id,
  });
}
