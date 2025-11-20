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

import { UrlReaderService } from '@backstage/backend-plugin-api';
import { TemplateInfo } from './github/types';

/**
 * GitHub repository URL for the scaffolder-relation-processor plugin
 *
 * @internal
 */
const SCAFFOLDER_RELATION_PROCESSOR_URL =
  'https://github.com/backstage/community-plugins/tree/main/workspaces/scaffolder-relation-processor/plugins/catalog-backend-module-scaffolder-relation-processor';

/**
 * Sanitizes a string for use in GitHub branch names
 * GitHub branch names: lowercase, no spaces, replace invalid chars with hyphens
 *
 * @param str - String to sanitize
 * @returns Sanitized string suitable for branch names
 *
 * @internal
 */
function sanitizeForBranch(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * Creates a branch name for template upgrade PRs
 *
 * @param templateInfo - Template information
 * @returns Branch name in format [COMPONENT_NAME]/template-upgrade-v[NEW_VERSION]
 *
 * @internal
 */
export function createTemplateUpgradeBranchName(
  templateInfo: TemplateInfo,
): string {
  return `${sanitizeForBranch(
    templateInfo.componentName,
  )}/template-upgrade-v${sanitizeForBranch(templateInfo.currentVersion)}`;
}

/**
 * Creates a commit message for template upgrade PRs
 *
 * @param templateInfo - Template information
 * @param filesCount - Number of files being updated
 * @returns Commit message
 *
 * @internal
 */
export function createTemplateUpgradeCommitMessage(
  templateInfo: TemplateInfo,
  filesCount: number,
): string {
  return `Update template to new version

This PR was automatically created by scaffolder-relation-processor. 

Template source: ${templateInfo.owner}/${templateInfo.repo}
Updated ${filesCount} file(s) to match the latest template version.

Please manually review the changes to ensure they are correct before merging.`;
}

/**
 * Creates a PR body for template upgrade PRs
 *
 * @param templateInfo - Template information
 * @param filesCount - Number of files being updated
 * @returns PR body text
 *
 * @internal
 */
export function createTemplateUpgradePrBody(
  templateInfo: TemplateInfo,
  filesCount: number,
): string {
  return `This pull request was automatically created by [scaffolder-relation-processor](${SCAFFOLDER_RELATION_PROCESSOR_URL}) in order to keep the scaffolded repository in sync with the template.
    
**Template Source:** ${templateInfo.owner}/${templateInfo.repo}

**Updated Files:** ${filesCount} file(s) have been updated to match the latest template version.

⚠️ **Please manually review the changes to ensure they are correct before merging.**`;
}

/**
 * Creates a PR title for template upgrade PRs
 *
 * @param templateInfo - Template information
 * @returns PR title
 *
 * @internal
 */
export function createTemplateUpgradePrTitle(
  templateInfo: TemplateInfo,
): string {
  if (templateInfo.previousVersion && templateInfo.currentVersion) {
    return `Template Upgrade: Update ${templateInfo.name} from ${templateInfo.previousVersion} to ${templateInfo.currentVersion}`;
  }
  return `Template Upgrade: Update ${templateInfo.name} to ${
    templateInfo.currentVersion || 'new version'
  }`;
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
 * Finds common files between template and scaffolded repositories
 *
 * @param templateFiles - Map of template file paths to content
 * @param scaffoldedFiles - Map of scaffolded file paths to content
 * @returns Array of common file paths
 *
 * @internal
 */
export function findCommonFiles(
  templateFiles: Map<string, string>,
  scaffoldedFiles: Map<string, string>,
): string[] {
  return Array.from(templateFiles.keys()).filter(file =>
    scaffoldedFiles.has(file),
  );
}
