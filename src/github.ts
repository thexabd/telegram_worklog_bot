import { graphql } from '@octokit/graphql';

export interface ProjectField {
  id: string;
  name: string;
  dataType: string;
}

export interface ProjectInfo {
  id: string;
  number: number;
  title: string;
  fields: ProjectField[];
}

export interface ProjectItemRef {
  id: string;
  projectId: string;
  projectNumber: number;
}

export interface IssueData {
  id: string;
  title: string;
  url: string;
  number: number;
  repositoryId: string;
  projectItems: ProjectItemRef[];
}

export interface CreatedIssue {
  id: string;
  number: number;
  url: string;
  title: string;
}

export interface WorklogEntry {
  date: string;
  minutes: number;
  owner: string | null;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
}

export class GitHubClient {
  private gql: typeof graphql;

  constructor(token: string) {
    this.gql = graphql.defaults({
      headers: { authorization: `token ${token}` },
    });
  }

  async getProject(owner: string, projectNumber: number): Promise<ProjectInfo> {
    const fragment = `
      id
      title
      number
      fields(first: 30) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
        }
      }
    `;

    const tryOwner = async (
      rootField: 'organization' | 'user',
    ): Promise<any> => {
      try {
        const res: any = await this.gql(
          `query($owner: String!, $number: Int!) {
            ${rootField}(login: $owner) { projectV2(number: $number) { ${fragment} } }
          }`,
          { owner, number: projectNumber },
        );
        return res?.[rootField]?.projectV2 ?? null;
      } catch (err: any) {
        const onlyNotFound =
          Array.isArray(err?.errors) &&
          err.errors.every((e: any) => e?.type === 'NOT_FOUND');
        const partial = err?.data?.[rootField]?.projectV2 ?? null;
        if (partial) return partial;
        if (onlyNotFound) return null;
        throw err;
      }
    };

    let project: any = await tryOwner('organization');
    if (!project) project = await tryOwner('user');

    if (!project) {
      throw new Error(
        `Project #${projectNumber} not found for owner "${owner}". Check GITHUB_OWNER, GITHUB_PROJECT_NUMBER, and that your token has the "project" scope (plus "read:org" if the owner is an organization).`,
      );
    }

    return {
      id: project.id,
      number: project.number,
      title: project.title,
      fields: (project.fields?.nodes ?? []).filter(
        (n: any) => n && typeof n.id === 'string',
      ),
    };
  }

  async getIssue(
    owner: string,
    repo: string,
    number: number,
  ): Promise<IssueData> {
    const res: any = await this.gql(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          id
          issue(number: $number) {
            id title url number
            projectItems(first: 20) {
              nodes { id project { id number } }
            }
          }
        }
      }`,
      { owner, repo, number },
    );
    const repository = res?.repository;
    const issue = repository?.issue;
    if (!repository || !issue) {
      throw new Error(`Issue #${number} not found in ${owner}/${repo}.`);
    }
    return {
      id: issue.id,
      title: issue.title,
      url: issue.url,
      number: issue.number,
      repositoryId: repository.id,
      projectItems: (issue.projectItems?.nodes ?? []).map((n: any) => ({
        id: n.id,
        projectId: n.project.id,
        projectNumber: n.project.number,
      })),
    };
  }

  async createIssue(
    repositoryId: string,
    title: string,
    body?: string,
  ): Promise<CreatedIssue> {
    const res: any = await this.gql(
      `mutation($repositoryId: ID!, $title: String!, $body: String) {
        createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body }) {
          issue { id number url title }
        }
      }`,
      { repositoryId, title, body: body ?? null },
    );
    const issue = res.createIssue.issue;
    return {
      id: issue.id,
      number: issue.number,
      url: issue.url,
      title: issue.title,
    };
  }

  async getUserId(login: string): Promise<string> {
    const res: any = await this.gql(
      `query($login: String!) { user(login: $login) { id } }`,
      { login },
    );
    const id = res?.user?.id;
    if (!id) throw new Error(`GitHub user "${login}" not found.`);
    return id;
  }

  async addAssignees(
    assignableId: string,
    assigneeIds: string[],
  ): Promise<void> {
    await this.gql(
      `mutation($assignableId: ID!, $assigneeIds: [ID!]!) {
        addAssigneesToAssignable(input: { assignableId: $assignableId, assigneeIds: $assigneeIds }) {
          assignable { ... on Issue { id } }
        }
      }`,
      { assignableId, assigneeIds },
    );
  }

  async addSubIssue(parentIssueId: string, subIssueId: string): Promise<void> {
    await this.gql(
      `mutation($issueId: ID!, $subIssueId: ID!) {
        addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
          issue { id }
        }
      }`,
      { issueId: parentIssueId, subIssueId },
    );
  }

  async closeIssue(
    issueId: string,
    stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'DUPLICATE' = 'COMPLETED',
  ): Promise<void> {
    await this.gql(
      `mutation($issueId: ID!, $stateReason: IssueClosedStateReason) {
        closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) {
          issue { id state }
        }
      }`,
      { issueId, stateReason },
    );
  }

  async addIssueToProject(
    projectId: string,
    contentId: string,
  ): Promise<string> {
    const res: any = await this.gql(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`,
      { projectId, contentId },
    );
    return res.addProjectV2ItemById.item.id;
  }

  async updateDateField(
    projectId: string,
    itemId: string,
    fieldId: string,
    date: string,
  ): Promise<void> {
    await this.gql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
          value: { date: $date }
        }) { projectV2Item { id } }
      }`,
      { projectId, itemId, fieldId, date },
    );
  }

  async updateNumberField(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: number,
  ): Promise<void> {
    await this.gql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
          value: { number: $value }
        }) { projectV2Item { id } }
      }`,
      { projectId, itemId, fieldId, value },
    );
  }

  async listWorklogsForAssignee(
    projectId: string,
    assignee: string,
    owner: string,
    fieldNames: { date: string; minutes: string },
    dateFrom?: string,
    dateTo?: string,
  ): Promise<WorklogEntry[]> {
    const entries: WorklogEntry[] = [];
    let cursor: string | null = null;
    const q = `assignee:${assignee} is:issue user:${owner}`;
    do {
      const res: any = await this.gql(
        `query($q: String!, $cursor: String) {
          search(query: $q, type: ISSUE, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on Issue {
                number
                title
                url
                projectItems(first: 10) {
                  nodes {
                    project { id }
                    fieldValues(first: 20) {
                      nodes {
                        __typename
                        ... on ProjectV2ItemFieldDateValue {
                          date
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                        ... on ProjectV2ItemFieldNumberValue {
                          number
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { q, cursor },
      );
      const search = res?.search;
      const nodes: any[] = search?.nodes ?? [];
      for (const issue of nodes) {
        const items: any[] = issue?.projectItems?.nodes ?? [];
        const item = items.find((it) => it?.project?.id === projectId);
        if (!item) continue;
        let date: string | null = null;
        let minutes: number | null = null;
        for (const fv of item?.fieldValues?.nodes ?? []) {
          const name = fv?.field?.name;
          if (!name) continue;
          if (name === fieldNames.date && typeof fv.date === 'string') {
            date = fv.date;
          } else if (
            name === fieldNames.minutes &&
            typeof fv.number === 'number'
          ) {
            minutes = fv.number;
          }
        }
        if (!date || typeof minutes !== 'number') continue;
        if (dateFrom && date < dateFrom) continue;
        if (dateTo && date > dateTo) continue;
        entries.push({
          date,
          minutes,
          owner: assignee,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
        });
      }
      cursor = search?.pageInfo?.hasNextPage
        ? search.pageInfo.endCursor
        : null;
    } while (cursor);
    return entries;
  }

  async updateTextField(
    projectId: string,
    itemId: string,
    fieldId: string,
    text: string,
  ): Promise<void> {
    await this.gql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
          value: { text: $text }
        }) { projectV2Item { id } }
      }`,
      { projectId, itemId, fieldId, text },
    );
  }
}

export function findField(fields: ProjectField[], name: string): ProjectField {
  const f = fields.find((x) => x.name === name);
  if (!f) {
    const available = fields.map((x) => x.name).join(', ') || '(none)';
    throw new Error(
      `Field "${name}" not found on project. Available: ${available}`,
    );
  }
  return f;
}
