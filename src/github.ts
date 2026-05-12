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
  projectItems: ProjectItemRef[];
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
    const issue = res?.repository?.issue;
    if (!issue) {
      throw new Error(`Issue #${number} not found in ${owner}/${repo}.`);
    }
    return {
      id: issue.id,
      title: issue.title,
      url: issue.url,
      number: issue.number,
      projectItems: (issue.projectItems?.nodes ?? []).map((n: any) => ({
        id: n.id,
        projectId: n.project.id,
        projectNumber: n.project.number,
      })),
    };
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
