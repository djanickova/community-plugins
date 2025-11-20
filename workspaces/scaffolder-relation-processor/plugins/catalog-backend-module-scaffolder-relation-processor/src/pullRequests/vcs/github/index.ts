/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Octokit } from '@octokit/core';
import type { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  createPullRequest,
  DELETE_FILE,
} from 'octokit-plugin-create-pull-request';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import {
  GithubParsedUrl,
  OctokitWithCreatePullRequest,
  TemplateInfo,
} from './types';
import gitUrlParse from 'git-url-parse';
import {
  createTemplateUpgradeBranchName,
  createTemplateUpgradeCommitMessage,
  createTemplateUpgradePrBody,
  createTemplateUpgradePrTitle,
} from '../common';
import { CatalogClient } from '@backstage/catalog-client';
import type { Entity } from '@backstage/catalog-model';

/**
 * Gets GitHub credentials and creates an Octokit instance with pull request plugin
 *
 * @param config - Backstage config
 * @param repoUrl - GitHub repository URL
 * @returns Octokit instance with createPullRequest plugin
 *
 * @internal
 */
export async function getGitHubClient(
  config: Config,
  repoUrl: string,
): Promise<OctokitWithCreatePullRequest | null> {
  try {
    const integrations = ScmIntegrations.fromConfig(config);
    const urlObj = new URL(repoUrl);
    const host = urlObj.hostname;

    const githubIntegration = integrations.github.byHost(host);
    if (!githubIntegration) {
      return null;
    }

    const baseUrl = githubIntegration.config.apiBaseUrl;

    // Use DefaultGithubCredentialsProvider which supports GitHub Apps
    const credentialsProvider =
      DefaultGithubCredentialsProvider.fromIntegrations(integrations);

    const credentials = await credentialsProvider.getCredentials({
      url: repoUrl,
    });

    const token = credentials?.token || githubIntegration.config.token || null;

    if (!token) {
      return null;
    }

    // Create Octokit instance with the createPullRequest plugin
    const OctokitWithPlugin = Octokit.plugin(createPullRequest);
    const octokit = new OctokitWithPlugin({
      auth: token,
      ...(baseUrl && { baseUrl }),
    });
    return octokit;
  } catch {
    return null;
  }
}

/**
 * Parses a GitHub URL to extract owner, repo, branch, and path
 *
 * @param url - GitHub URL (e.g., https://github.com/owner/repo/tree/branch/path)
 * @returns Parsed GitHub URL information
 *
 * @internal
 */
export function parseGitHubUrl(url: string): GithubParsedUrl | null {
  try {
    const parsed = gitUrlParse(url);

    if (parsed.source !== 'github.com' && parsed.resource !== 'github.com') {
      return null;
    }
    if (!parsed.owner || !parsed.name) {
      return null;
    }

    return {
      owner: parsed.owner,
      repo: parsed.name,
      branch: parsed.ref || undefined,
      path: parsed.filepath || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Requests a review from a reviewer for a pull request
 *
 * @param octokit - Octokit instance
 * @param logger - Logger service
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pullNumber - Pull request number
 * @param reviewer - GitHub username to request review from
 *
 * @internal
 */
async function requestPullRequestReview(
  octokit: OctokitWithCreatePullRequest,
  logger: LoggerService,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewer: string,
): Promise<void> {
  try {
    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
      {
        owner,
        repo,
        pull_number: pullNumber,
        reviewers: [reviewer],
      },
    );
    logger.info(
      `Requested review from ${reviewer} for pull request #${pullNumber}`,
    );
  } catch (error) {
    logger.warn(
      `Failed to request review from ${reviewer} for pull request #${pullNumber}: ${error}`,
    );
  }
}

/**
 * Creates a pull request with updated template files
 *
 * @param logger - Logger service
 * @param config - Backstage config
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param filesToUpdate - Map of file paths to updated content or null for deletions
 * @param templateInfo - Template information including owner, repo, branch, name, versions, and component name
 * @param reviewer - Optional GitHub username to request review from
 *
 * @internal
 */
export async function createPullRequestWithUpdates(
  logger: LoggerService,
  config: Config,
  owner: string,
  repo: string,
  filesToUpdate: Map<string, string | null>,
  templateInfo: TemplateInfo,
  reviewer: string | null,
): Promise<void> {
  try {
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const octokit = await getGitHubClient(config, repoUrl);

    if (!octokit) {
      logger.warn(
        `Could not get GitHub client to create PR for ${owner}/${repo}`,
      );
      return;
    }

    // Prepare files object for the plugin
    const files: Record<string, string | typeof DELETE_FILE> = {};
    for (const [filePath, content] of filesToUpdate.entries()) {
      files[filePath] = content === null ? DELETE_FILE : content;
    }

    const branchName = createTemplateUpgradeBranchName(templateInfo);
    const commitMessage = createTemplateUpgradeCommitMessage(
      templateInfo,
      filesToUpdate.size,
    );
    const prBody = createTemplateUpgradePrBody(
      templateInfo,
      filesToUpdate.size,
    );
    const prTitle = createTemplateUpgradePrTitle(templateInfo);

    const prOptions = {
      owner,
      repo,
      title: prTitle,
      body: prBody,
      head: branchName,
      changes: [
        {
          files,
          commit: commitMessage,
        },
      ],
    };

    const pr = await octokit.createPullRequest(prOptions);

    if (!pr) {
      logger.warn(`No pull request was created for ${owner}/${repo}.`);
      return;
    }

    logger.info(
      `Created template update pull request #${pr.data.number} for ${owner}/${repo}: ${pr.data.html_url}`,
    );

    // Request review from reviewer if provided
    if (reviewer) {
      await requestPullRequestReview(
        octokit,
        logger,
        owner,
        repo,
        pr.data.number,
        reviewer,
      );
    }
  } catch (error) {
    logger.error(
      `Error creating template update pull request for ${owner}/${repo}: ${error}`,
    );
  }
}

/**
 * Extracts the GitHub login from the owner entity if it's a User
 *
 * @param catalogClient - Catalog client to fetch owner entity
 * @param ownerRef - Owner entity reference
 * @param token - Auth token for catalog API
 * @returns GitHub login if owner is a User with the annotation, null otherwise
 *
 * @internal
 */
export async function getOwnerGitHubLogin(
  catalogClient: CatalogClient,
  ownerRef: string,
  token: string,
): Promise<string | null> {
  try {
    const ownerEntity = await catalogClient.getEntityByRef(ownerRef, { token });

    if (!ownerEntity) {
      return null;
    }

    // Only assign to Users, not Groups
    if (ownerEntity.kind !== 'User') {
      return null;
    }

    const githubLogin =
      ownerEntity.metadata.annotations?.['github.com/user-login'];
    return githubLogin || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extracts GitHub repository information from entity annotations
 *
 * @param scaffoldedEntity - The scaffolded entity
 * @returns Object with owner and repo, or null if not found/invalid
 *
 * @internal
 */
export function extractGithubRepoInfo(
  scaffoldedEntity: Entity,
): { owner: string; repo: string } | null {
  const scaffoldedRepoSlug =
    scaffoldedEntity.metadata.annotations?.['github.com/project-slug'];

  if (!scaffoldedRepoSlug) {
    return null;
  }

  const [owner, repo] = scaffoldedRepoSlug.split('/');
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

/**
 * Gets the reviewer GitHub login from the scaffolded entity's owner
 *
 * @param catalogClient - Catalog client to fetch owner entity
 * @param scaffoldedEntity - The scaffolded entity
 * @param token - Auth token for catalog API
 * @returns GitHub login if owner is a User, null otherwise
 *
 * @internal
 */
export async function getReviewerFromOwner(
  catalogClient: CatalogClient,
  scaffoldedEntity: Entity,
  token: string,
): Promise<string | null> {
  const ownerRef = scaffoldedEntity.spec?.owner?.toString();
  if (!ownerRef) {
    return null;
  }

  return getOwnerGitHubLogin(catalogClient, ownerRef, token);
}
