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
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
        }
      }
    `;

    let project: any = null;
    try {
      const res: any = await this.gql(
        `query($owner: String!, $number: Int!) {
          organization(login: $owner) { projectV2(number: $number) { ${fragment} } }
        }`,
        { owner, number: projectNumber },
      );
      project = res?.organization?.projectV2 ?? null;
    } catch {
      // owner may be a user, not an org — fall through
    }

    if (!project) {
      const res: any = await this.gql(
        `query($owner: String!, $number: Int!) {
          user(login: $owner) { projectV2(number: $number) { ${fragment} } }
        }`,
        { owner, number: projectNumber },
      );
      project = res?.user?.projectV2 ?? null;
    }

    if (!project) {
      throw new Error(
        `Project #${projectNumber} not found for owner "${owner}". Check GITHUB_OWNER, GITHUB_PROJECT_NUMBER, and that your token has the "project" scope.`,
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

  async getViewer(): Promise<{ login: string; id: string }> {
    const res: any = await this.gql(`query { viewer { login id } }`);
    if (!res?.viewer?.login || !res?.viewer?.id) {
      throw new Error('Could not resolve viewer from token.');
    }
    return { login: res.viewer.login, id: res.viewer.id };
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
