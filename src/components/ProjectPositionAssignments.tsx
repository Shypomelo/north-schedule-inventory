"use client";

import { useCallback, useEffect, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import type { Position, ProjectPositionAssignment, User } from '@/lib/db/types';
import { resolveProjectPositionMemberId } from '@/lib/engineering-responsibilities';

export function ProjectPositionAssignments({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [assignments, setAssignments] = useState<ProjectPositionAssignment[]>([]);
  const [candidates, setCandidates] = useState<Record<string, User[]>>({});
  const [savingPositionId, setSavingPositionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [positionRows, assignmentRows] = await Promise.all([
        dbAdapter.getProjectResponsiblePositions(projectId),
        dbAdapter.getProjectPositionAssignments(projectId),
      ]);
      const candidateRows = await Promise.all(positionRows.map(async position => [
        position.id,
        await dbAdapter.getPositionCandidates(position.id),
      ] as const));
      setPositions(positionRows);
      setAssignments(assignmentRows);
      setCandidates(Object.fromEntries(candidateRows));
    } catch (loadError: any) {
      setError(loadError.message || '無法載入專案分工');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const assign = async (positionId: string, memberId: string) => {
    if (!canEdit) return;
    setSavingPositionId(positionId);
    setError(null);
    try {
      if (memberId) {
        const saved = await dbAdapter.upsertProjectPositionAssignment(projectId, positionId, memberId);
        setAssignments(current => [
          ...current.filter(row => row.position_id !== positionId),
          saved,
        ]);
      } else {
        await dbAdapter.clearProjectPositionAssignment(projectId, positionId);
        setAssignments(current => current.filter(row => row.position_id !== positionId));
      }
    } catch (saveError: any) {
      setError(saveError.message || '專案分工儲存失敗');
    } finally {
      setSavingPositionId(null);
    }
  };

  return (
    <section className="border-t border-theme-border pt-4">
      <h3 className="text-sm font-semibold text-primary">專案分工</h3>
      <p className="mt-1 text-xs text-secondary">依此專案流程實際使用的負責職位設定人員，可保留未指派。</p>
      {error && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {positions.map(position => {
          const assignment = assignments.find(row => row.position_id === position.id);
          const candidateMembers = candidates[position.id] ?? [];
          const selectedMemberId = resolveProjectPositionMemberId(assignment, candidateMembers);
          return (
            <label key={position.id} className="text-sm text-secondary">
              {position.name}
              <select
                value={selectedMemberId}
                onChange={event => void assign(position.id, event.target.value)}
                disabled={!canEdit || savingPositionId === position.id}
                className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-primary outline-none focus:border-accent disabled:opacity-60"
              >
                <option value="">未指派</option>
                {candidateMembers.map(member => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            </label>
          );
        })}
        {positions.length === 0 && !error && (
          <p className="text-sm text-secondary">此專案流程目前沒有設定負責職位。</p>
        )}
      </div>
    </section>
  );
}
