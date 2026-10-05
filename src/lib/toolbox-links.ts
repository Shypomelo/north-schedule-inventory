export type ToolLinkScope = 'PERSONAL' | 'DEPARTMENT' | 'GLOBAL';

export type ToolLink = {
  id: string;
  name: string;
  url: string;
  category: string;
  icon_key: string | null;
  sort_order: number;
  scope: ToolLinkScope;
  owner_member_id: string | null;
  work_group_id: string | null;
};

export const toolLinkScopeLabels: Record<ToolLinkScope, string> = {
  PERSONAL: '個人',
  DEPARTMENT: '部門',
  GLOBAL: '全部',
};

export function creatableToolLinkScopes(role: string | undefined): ToolLinkScope[] {
  return role === 'ADMIN' ? ['PERSONAL', 'DEPARTMENT', 'GLOBAL'] : ['PERSONAL'];
}

export function newToolLinkValues(input: {
  url: string;
  name: string;
  scope: ToolLinkScope;
  workGroupId: string | null;
  memberId: string;
  links: ToolLink[];
}) {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error('請輸入有效的 HTTPS 網址。');
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error('請輸入有效的 HTTPS 網址。');
  }
  if (input.scope === 'DEPARTMENT' && !input.workGroupId) {
    throw new Error('請選擇部門。');
  }

  const sameList = input.links.filter(link =>
    link.scope === input.scope &&
    (input.scope === 'GLOBAL' ||
      (input.scope === 'PERSONAL' && link.owner_member_id === input.memberId) ||
      (input.scope === 'DEPARTMENT' && link.work_group_id === input.workGroupId)));
  const sortOrder = sameList.reduce((last, link) => Math.max(last, link.sort_order), -1) + 1;

  return {
    name: input.name.trim() || url.hostname,
    url: url.toString(),
    category: '常用',
    description: null,
    icon_key: null,
    sort_order: sortOrder,
    scope: input.scope,
    owner_member_id: input.scope === 'PERSONAL' ? input.memberId : null,
    work_group_id: input.scope === 'DEPARTMENT' ? input.workGroupId : null,
  };
}
