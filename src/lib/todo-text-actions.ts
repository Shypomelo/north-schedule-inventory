import type { Todo, User } from './db/types';

export function canEditTodoText(todo: Todo, actor: User | null): boolean {
  return Boolean(actor?.is_active && actor.role !== 'VIEWER' && (todo.scope === 'TEAM' || todo.created_by === actor.id));
}

export async function saveTodoText(adapter: { updateTodo: (id: string, data: any) => Promise<any>; updatePrivateTodo: (id: string, data: any) => Promise<any> }, todo: Todo, actor: User | null, input: { title: string; content: string | null }) {
  if (!canEditTodoText(todo, actor)) throw new Error('沒有編輯此待辦的權限');
  const payload = { title: input.title.trim(), content: input.content?.trim() || null };
  if (!payload.title) throw new Error('標題為必填');
  // DB's existing trigger handles TEAM history and excludes PRIVATE history.
  // Do not synchronize a converted Schedule or accept any metadata from the form.
  return todo.scope === 'PRIVATE'
    ? adapter.updatePrivateTodo(todo.id, payload)
    : adapter.updateTodo(todo.id, payload);
}
