"use client";

import React, { useEffect, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import type {
  ProjectDifficultyAssessment,
  ProjectDifficultyAssessmentType,
} from '@/lib/db/types';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';

type ScoreField =
  | 'overall_difficulty'
  | 'owner_communication_difficulty'
  | 'site_construction_difficulty'
  | 'site_coordination_difficulty';

type Draft = Record<ScoreField, number | null> & { notes: string };

type Props = {
  projectId: string;
  actor: { id: string; name: string } | null;
  canEdit: boolean;
};

const ASSESSMENT_SECTIONS: { type: ProjectDifficultyAssessmentType; label: string }[] = [
  { type: 'PRE_ESTIMATE', label: '主管預估' },
  { type: 'POST_EXECUTION', label: '執行後回評' },
];

const SCORE_FIELDS: { key: ScoreField; label: string }[] = [
  { key: 'overall_difficulty', label: '整體難度' },
  { key: 'owner_communication_difficulty', label: '業主溝通' },
  { key: 'site_construction_difficulty', label: '現場施工' },
  { key: 'site_coordination_difficulty', label: '現場配合' },
];

const emptyDraft = (): Draft => ({
  overall_difficulty: null,
  owner_communication_difficulty: null,
  site_construction_difficulty: null,
  site_coordination_difficulty: null,
  notes: '',
});

const toDraft = (assessment: ProjectDifficultyAssessment): Draft => ({
  overall_difficulty: assessment.overall_difficulty,
  owner_communication_difficulty: assessment.owner_communication_difficulty,
  site_construction_difficulty: assessment.site_construction_difficulty,
  site_coordination_difficulty: assessment.site_coordination_difficulty,
  notes: assessment.notes || '',
});

export function ProjectDifficultyAssessments({ projectId, actor, canEdit }: Props) {
  const [assessments, setAssessments] = useState<ProjectDifficultyAssessment[]>([]);
  const [drafts, setDrafts] = useState<Record<ProjectDifficultyAssessmentType, Draft>>({
    PRE_ESTIMATE: emptyDraft(),
    POST_EXECUTION: emptyDraft(),
  });
  const [isLoading, setIsLoading] = useState(true);
  const [savingType, setSavingType] = useState<ProjectDifficultyAssessmentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);

    dbAdapter.getProjectDifficultyAssessments(projectId)
      .then(rows => {
        if (!active) return;
        setAssessments(rows);
        setDrafts({
          PRE_ESTIMATE: rows.find(row => row.assessment_type === 'PRE_ESTIMATE')
            ? toDraft(rows.find(row => row.assessment_type === 'PRE_ESTIMATE')!)
            : emptyDraft(),
          POST_EXECUTION: rows.find(row => row.assessment_type === 'POST_EXECUTION')
            ? toDraft(rows.find(row => row.assessment_type === 'POST_EXECUTION')!)
            : emptyDraft(),
        });
      })
      .catch(loadError => {
        if (active) setError(getDatabaseErrorMessage(loadError, '無法載入案場難度'));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => { active = false; };
  }, [projectId]);

  const setDraft = (
    assessmentType: ProjectDifficultyAssessmentType,
    update: Partial<Draft>,
  ) => {
    setDrafts(current => ({
      ...current,
      [assessmentType]: { ...current[assessmentType], ...update },
    }));
  };

  const save = async (assessmentType: ProjectDifficultyAssessmentType) => {
    const draft = drafts[assessmentType];
    const missingScore = SCORE_FIELDS.some(field => draft[field.key] === null);
    if (missingScore) {
      setError('請完成四項 1～5 難度評分');
      return;
    }
    if (!actor) {
      setError('無法確認填寫人，請重新登入後再試');
      return;
    }

    setSavingType(assessmentType);
    setError(null);
    try {
      const scores = {
        overall_difficulty: draft.overall_difficulty!,
        owner_communication_difficulty: draft.owner_communication_difficulty!,
        site_construction_difficulty: draft.site_construction_difficulty!,
        site_coordination_difficulty: draft.site_coordination_difficulty!,
      };
      const existing = assessments.find(row => row.assessment_type === assessmentType);
      const saved = existing
        ? await dbAdapter.updateProjectDifficultyAssessment(existing.id, {
            ...scores,
            notes: draft.notes || null,
          })
        : await dbAdapter.createProjectDifficultyAssessment({
            project_id: projectId,
            assessment_type: assessmentType,
            ...scores,
            evaluator_user_id: actor.id,
            evaluator_name: actor.name,
            notes: draft.notes || null,
          });

      setAssessments(current => existing
        ? current.map(row => row.id === saved.id ? saved : row)
        : [...current, saved]);
      setDrafts(current => ({ ...current, [assessmentType]: toDraft(saved) }));
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '案場難度儲存失敗'));
    } finally {
      setSavingType(null);
    }
  };

  if (isLoading) {
    return <div className="text-sm text-secondary">案場難度載入中...</div>;
  }

  return (
    <section className="border-t border-theme-border pt-4">
      <div className="mb-3">
        <h3 className="font-semibold text-primary">案場難度履歷</h3>
        <p className="text-xs text-secondary">只記錄預估與回評差異，不計算考績或排名。</p>
      </div>
      {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {ASSESSMENT_SECTIONS.map(section => {
          const draft = drafts[section.type];
          const existing = assessments.find(row => row.assessment_type === section.type);
          const isSaving = savingType === section.type;

          return (
            <div key={section.type} className="rounded-xl border border-theme-border bg-card/50 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-semibold text-primary">{section.label}</h4>
                {existing && <span className="text-xs text-secondary">填寫人：{existing.evaluator_name}</span>}
              </div>
              <div className="space-y-2">
                {SCORE_FIELDS.map(field => (
                  <div key={field.key} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-secondary">{field.label}</span>
                    <div className="flex items-center gap-1" role="group" aria-label={`${section.label}${field.label}`}>
                      {[1, 2, 3, 4, 5].map(score => (
                        <button
                          key={score}
                          type="button"
                          disabled={!canEdit || isSaving}
                          aria-label={`${field.label} ${score} 分`}
                          aria-pressed={draft[field.key] === score}
                          onClick={() => setDraft(section.type, { [field.key]: score })}
                          className={`h-7 w-7 rounded text-sm font-semibold transition ${draft[field.key] === score ? 'bg-accent text-white' : 'border border-theme-border bg-page text-secondary hover:border-accent hover:text-accent'} disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          {score}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <textarea
                value={draft.notes}
                onChange={event => setDraft(section.type, { notes: event.target.value })}
                disabled={!canEdit || isSaving}
                placeholder="備註（可空）"
                className="mt-3 min-h-16 w-full resize-none rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent disabled:opacity-50"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  disabled={!canEdit || isSaving}
                  onClick={() => void save(section.type)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? '儲存中...' : existing ? '更新評分' : '儲存評分'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
