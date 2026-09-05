import type {
  ProjectMilestone,
  ProjectMilestoneUpdate,
  ProjectWorkflow,
  WorkflowSnapshotResult,
} from '@/lib/db/types';
import type { WorkflowOuterKind } from '@/lib/project-workflow';
import { validateWorkflowActualDate } from '@/lib/project-workflow';

export type AuthoritativeMilestoneKey = 'INTERNAL_ACCEPTANCE' | 'METER_INSTALLATION';

interface WorkflowMilestoneGateway {
  initializeProjectWorkflow(projectId: string): Promise<WorkflowSnapshotResult>;
  getProjectWorkflow(projectId: string): Promise<ProjectWorkflow>;
  updateProjectMilestone(id: string, updates: ProjectMilestoneUpdate): Promise<ProjectMilestone>;
}

export interface AuthoritativeMilestoneMutation {
  projectId: string;
  milestoneId: string | null;
  milestoneKey: AuthoritativeMilestoneKey;
  kind: WorkflowOuterKind;
  updates: ProjectMilestoneUpdate;
  today: string;
}

export async function updateAuthoritativeMilestone(
  gateway: WorkflowMilestoneGateway,
  input: AuthoritativeMilestoneMutation,
): Promise<ProjectMilestone> {
  const actualDate = input.updates.actual_date;
  const validationError = validateWorkflowActualDate(input.kind, actualDate ?? null, input.today);
  if (validationError) throw new Error(validationError);

  let milestoneId = input.milestoneId;
  if (!milestoneId) {
    await gateway.initializeProjectWorkflow(input.projectId);
    const workflow = await gateway.getProjectWorkflow(input.projectId);
    milestoneId = workflow.milestones.find(milestone => (
      milestone.milestone_key === input.milestoneKey
      && milestone.deleted_at === null
      && milestone.is_applicable
    ))?.id ?? null;
  }

  if (!milestoneId) {
    throw new Error('請先在專案流程將此項目設為適用');
  }

  return gateway.updateProjectMilestone(milestoneId, input.updates);
}
