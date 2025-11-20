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

import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import { createHash } from 'crypto';
import { CatalogClient } from '@backstage/catalog-client';
import {
  buildRepositoryUrl,
  createPullRequestWithUpdates,
  getOwnerGitHubLogin,
  parseGitHubUrl,
} from './providers/github';
import { preprocessTemplate } from './templateProcessing';

/**
 * Extracts the template source URL from a template entity
 *
 * @param templateEntity - The template entity
 * @returns The source URL from the fetch:template action, or null if not found
 *
 * @internal
 */
export function extractTemplateSourceUrl(
  templateEntity: Entity,
): string | null {
  const spec = templateEntity.spec as any;
  if (!spec?.steps || !Array.isArray(spec.steps)) {
    return null;
  }

  for (const step of spec.steps) {
    if (step.action === 'fetch:template' && step.input?.url) {
      return step.input.url;
    }
  }

  return null;
}

/**
 * Fetches repository file tree using UrlReader
 *
 * @param urlReader - UrlReaderService instance
 * @param url - Repository URL (e.g., 'https://github.com/owner/repo/tree/branch/path')
 * @returns Map of file paths to their content
 *
 * @internal
 */
export async function fetchRepoFiles(
  urlReader: UrlReaderService,
  url: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  try {
    const tree = await urlReader.readTree(url);

    const treeFiles = await tree.files();

    for (const file of treeFiles) {
      try {
        const content = await file.content();
        files.set(file.path, content.toString('utf-8'));
      } catch (error) {
        continue;
      }
    }

    return files;
  } catch (error) {
    throw new Error(`Error fetching repository files: ${error}`);
  }
}

/**
 * Creates a hash of file content for comparison
 *
 * @param content - File content to hash
 * @returns SHA-256 hash of the content
 *
 * @internal
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compares two files by comparing their hashes
 *
 * @param templateContent - Preprocessed template content (with variables replaced)
 * @param scaffoldedContent - Content from scaffolded file
 * @returns True if files are identical, false if difference found
 *
 * @internal
 */
function compareFilesByHash(
  templateContent: string,
  scaffoldedContent: string,
): boolean {
  return hashContent(templateContent) === hashContent(scaffoldedContent);
}

/**
 * Extracts GitHub repository information from entity annotations
 *
 * @param scaffoldedEntity - The scaffolded entity
 * @returns Object with owner and repo, or null if not found/invalid
 *
 * @internal
 */
function extractGithubRepoInfo(
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
 * Finds common files between template and scaffolded repositories
 *
 * @param templateFiles - Map of template file paths to content
 * @param scaffoldedFiles - Map of scaffolded file paths to content
 * @returns Array of common file paths
 *
 * @internal
 */
function findCommonFiles(
  templateFiles: Map<string, string>,
  scaffoldedFiles: Map<string, string>,
): string[] {
  return Array.from(templateFiles.keys()).filter(file =>
    scaffoldedFiles.has(file),
  );
}

/**
 * Compares common files and collects files that need updating
 *
 * @param commonFiles - Array of common file paths
 * @param templateFiles - Map of template file paths to content
 * @param scaffoldedFiles - Map of scaffolded file paths to content
 * @returns Map of file paths to preprocessed template content that need updating
 *
 * @internal
 */
function compareCommonFiles(
  commonFiles: string[],
  templateFiles: Map<string, string>,
  scaffoldedFiles: Map<string, string>,
): Map<string, string> {
  const filesToUpdate = new Map<string, string>();

  if (commonFiles.length === 0) {
    return filesToUpdate;
  }

  for (const file of commonFiles) {
    const templateContent = templateFiles.get(file);
    const scaffoldedContent = scaffoldedFiles.get(file);

    if (!templateContent || !scaffoldedContent) {
      continue;
    }

    // Preprocess template by replacing template variables with scaffolded values
    const preprocessedTemplate = preprocessTemplate(
      templateContent,
      scaffoldedContent,
    );

    const isIdentical = compareFilesByHash(
      preprocessedTemplate,
      scaffoldedContent,
    );

    if (!isIdentical) {
      filesToUpdate.set(file, preprocessedTemplate);
    }
  }

  return filesToUpdate;
}

/**
 * Fetches and compares files between template and scaffolded repositories
 *
 * @param urlReader - UrlReaderService instance
 * @param scaffoldedUrl - Scaffolded repository URL
 * @param templateFiles - Pre-fetched template files
 * @returns Map of files that need updating, or null if error occurs
 *
 * @internal
 */
async function fetchAndCompareFiles(
  urlReader: UrlReaderService,
  scaffoldedUrl: string,
  templateFiles: Map<string, string>,
): Promise<Map<string, string> | null> {
  try {
    const scaffoldedFiles = await fetchRepoFiles(urlReader, scaffoldedUrl);

    const commonFiles = findCommonFiles(templateFiles, scaffoldedFiles);
    return compareCommonFiles(commonFiles, templateFiles, scaffoldedFiles);
  } catch (error) {
    return null;
  }
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
async function getReviewerFromOwner(
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

/**
 * Creates a pull request to sync template changes with a scaffolded repository
 *
 * @param logger - Logger service
 * @param urlReader - UrlReaderService instance
 * @param config - Backstage config
 * @param catalogClient - Catalog client to fetch owner entity
 * @param templateSourceUrl - The source URL of the template
 * @param templateEntity - The template entity
 * @param scaffoldedEntity - The scaffolded entity
 * @param templateFiles - Pre-fetched template files map
 * @param previousVersion - Previous version of the template
 * @param currentVersion - Current version of the template
 * @param token - Auth token for catalog API
 *
 * @internal
 */
export async function createTemplateSyncPullRequest(
  logger: LoggerService,
  urlReader: UrlReaderService,
  config: Config,
  catalogClient: CatalogClient,
  templateEntity: Entity,
  templateSourceUrl: string,
  scaffoldedEntity: Entity,
  previousVersion: string,
  currentVersion: string,
  token: string,
  templateFiles: Map<string, string>,
): Promise<void> {
  const templateUrlInfo = parseGitHubUrl(templateSourceUrl);
  if (!templateUrlInfo) {
    logger.debug(`Could not parse template URL: ${templateSourceUrl}`);
    return;
  }
  const scaffoldedRepoInfo = extractGithubRepoInfo(scaffoldedEntity);
  if (!scaffoldedRepoInfo) {
    return;
  }
  const { owner: scaffoldedOwner, repo: scaffoldedRepo } = scaffoldedRepoInfo;

  const branch = 'main';
  const scaffoldedUrl = buildRepositoryUrl(scaffoldedRepoInfo, branch);

  try {
    const filesToUpdate = await fetchAndCompareFiles(
      urlReader,
      scaffoldedUrl,
      templateFiles,
    );

    if (!filesToUpdate) {
      logger.error(
        `Error fetching or comparing files for entity ${scaffoldedEntity.metadata.name}`,
      );
      return;
    }

    if (filesToUpdate.size === 0) {
      logger.info(
        `No differences found between template and scaffolded repository for entity ${scaffoldedEntity.metadata.name}. Skipping pull request creation.`,
      );
      return;
    }

    logger.info(
      `Creating template sync pull request for entity ${scaffoldedEntity.metadata.name}`,
    );

    const templateInfo = {
      owner: templateUrlInfo.owner,
      repo: templateUrlInfo.repo,
      branch,
      name: templateEntity.metadata.title ?? templateEntity.metadata.name,
      previousVersion,
      currentVersion,
      componentName: scaffoldedEntity.metadata.name,
    };

    const reviewer = await getReviewerFromOwner(
      catalogClient,
      scaffoldedEntity,
      token,
    );

    await createPullRequestWithUpdates(
      logger,
      config,
      scaffoldedOwner,
      scaffoldedRepo,
      filesToUpdate,
      templateInfo,
      reviewer,
    );
  } catch (error) {
    logger.error(
      `Error creating template sync pull request for entity ${scaffoldedEntity.metadata.name}: ${error}`,
    );
  }
}
