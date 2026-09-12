import type { Todo } from '@/lib/db/types';

type TeamTodoInboxFields = Pick<Todo, 'scope' | 'status' | 'converted_task_id' | 'work_group_id'>;

/** The canonical definition of a TEAM Todo that still belongs in an active inbox. */
export function isActiveTeamTodo(todo: TeamTodoInboxFields): boolean {
  return todo.scope === 'TEAM'
    && todo.status === '待安排'
    && todo.converted_task_id === null;
}

/** Select active TEAM Todo rows, optionally scoped to one work group. */
export function selectActiveTeamTodos<T extends TeamTodoInboxFields>(
  todos: readonly T[],
  workGroupId?: string | null,
): T[] {
  if (workGroupId === null) return [];
  return todos.filter(todo => (
    isActiveTeamTodo(todo)
    && (workGroupId === undefined || todo.work_group_id === workGroupId)
  ));
}
