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

import type { Config } from '@backstage/config';
import { CatalogClient } from '@backstage/catalog-client';
import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { fetchRepoFiles } from './vcs/utils/fileOperations';
import { fetchAndCompareFiles } from './comparison';
import { extractTemplateSourceUrl } from './template/entity';
import type { VcsProviderRegistry } from './vcs/VcsProviderRegistry';
import type {
  VcsProvider,
  ParsedUrl,
  PullRequestResult,
} from './vcs/VcsProvider';

/**
 * Context information for VCS providers and URLs
 *
 * @internal
 */
type VcsProviderContext = {
  templateProvider: VcsProvider;
  templateUrlInfo: ParsedUrl;
  scaffoldedProvider: VcsProvider;
  scaffoldedUrl: string;
};

/**
 * Retrieves and validates VCS providers for both template and scaffolded repositories
 *
 * @param vcsRegistry - VCS provider registry
 * @param templateSourceUrl - Template source URL
 * @param scaffoldedEntity - Scaffolded entity
 * @param logger - Logger service
 * @returns VCS provider context or null if validation fails
 *
 * @internal
 */
async function getVcsProviders(
  vcsRegistry: VcsProviderRegistry,
  templateSourceUrl: string,
  scaffoldedEntity: Entity,
  logger: LoggerService,
): Promise<VcsProviderContext | null> {
  // Get the provider for the template URL
  const templateProvider = vcsRegistry.getProviderForUrl(templateSourceUrl);
  if (!templateProvider) {
    logger.debug(
      `No VCS provider found for template URL: ${templateSourceUrl}`,
    );
    return null;
  }

  const templateUrlInfo = templateProvider.parseUrl(templateSourceUrl);
  if (!templateUrlInfo) {
    logger.debug(`Could not parse template URL: ${templateSourceUrl}`);
    return null;
  }

  // Get the provider for the scaffolded entity
  const scaffoldedProvider = vcsRegistry.getProviderForEntity(scaffoldedEntity);
  if (!scaffoldedProvider) {
    logger.debug(
      `No VCS provider found for entity ${scaffoldedEntity.metadata.name}`,
    );
    return null;
  }

  const scaffoldedUrl = scaffoldedProvider.extractRepoUrl(scaffoldedEntity);
  if (!scaffoldedUrl) {
    logger.debug(
      `Could not extract repository URL from entity ${scaffoldedEntity.metadata.name}`,
    );
    return null;
  }

  return {
    templateProvider,
    templateUrlInfo,
    scaffoldedProvider,
    scaffoldedUrl,
  };
}

/**
 * Fetches and compares files between template and scaffolded repositories
 *
 * @param urlReader - UrlReaderService instance
 * @param scaffoldedUrl - Scaffolded repository URL
 * @param templateFiles - Pre-fetched template files
 * @param logger - Logger service
 * @param entityName - Entity name for logging
 * @returns Map of files to update or null if comparison fails or no changes found
 *
 * @internal
 */
async function getFilesToUpdate(
  urlReader: UrlReaderService,
  scaffoldedUrl: string,
  templateFiles: Map<string, string>,
  logger: LoggerService,
  entityName: string,
): Promise<Map<string, string | null> | null> {
  const filesToUpdate = await fetchAndCompareFiles(
    urlReader,
    scaffoldedUrl,
    templateFiles,
  );

  if (!filesToUpdate) {
    logger.error(`Error fetching or comparing files for entity ${entityName}`);
    return null;
  }

  if (filesToUpdate.size === 0) {
    logger.info(
      `No differences found between template and scaffolded repository for entity ${entityName}. Skipping pull request creation.`,
    );
    return null;
  }

  return filesToUpdate;
}

/**
 * Submits a pull request with template updates
 *
 * @param scaffoldedProvider - VCS provider for scaffolded repository
 * @param scaffoldedEntity - The scaffolded entity
 * @param scaffoldedUrl - Scaffolded repository URL
 * @param templateEntity - The template entity
 * @param templateUrlInfo - Parsed template URL information
 * @param filesToUpdate - Map of files to create/update/delete
 * @param previousVersion - Previous version of the template
 * @param currentVersion - Current version of the template
 * @param token - Auth token for catalog API
 * @param logger - Logger service
 * @returns PullRequestResult containing the PR URL, or null if creation failed
 *
 * @internal
 */
async function submitPullRequest(
  scaffoldedProvider: VcsProvider,
  scaffoldedEntity: Entity,
  scaffoldedUrl: string,
  templateEntity: Entity,
  templateUrlInfo: ParsedUrl,
  filesToUpdate: Map<string, string | null>,
  previousVersion: string,
  currentVersion: string,
  token: string,
  logger: LoggerService,
): Promise<PullRequestResult | null> {
  logger.info(
    `Creating template sync pull request for entity ${scaffoldedEntity.metadata.name}`,
  );

  const templateInfo = {
    owner: templateUrlInfo.owner,
    repo: templateUrlInfo.repo,
    name: templateEntity.metadata.title ?? templateEntity.metadata.name,
    previousVersion,
    currentVersion,
    componentName: scaffoldedEntity.metadata.name,
  };

  const reviewer = await scaffoldedProvider.getReviewerFromOwner(
    scaffoldedEntity,
    token,
  );

  return scaffoldedProvider.createPullRequest(
    scaffoldedUrl,
    filesToUpdate,
    templateInfo,
    reviewer,
  );
}

/**
 * Creates a pull request to sync template changes with a scaffolded repository
 *
 * @param logger - Logger service
 * @param urlReader - UrlReaderService instance
 * @param vcsRegistry - VCS provider registry
 * @param templateEntity - The template entity
 * @param templateSourceUrl - The source URL of the template
 * @param scaffoldedEntity - The scaffolded entity
 * @param previousVersion - Previous version of the template
 * @param currentVersion - Current version of the template
 * @param token - Auth token for catalog API
 * @param templateFiles - Pre-fetched template files map
 * @returns PullRequestResult containing the PR URL, or null if creation failed
 *
 * @internal
 */
async function createTemplateUpdatePullRequest(
  logger: LoggerService,
  urlReader: UrlReaderService,
  vcsRegistry: VcsProviderRegistry,
  templateEntity: Entity,
  templateSourceUrl: string,
  scaffoldedEntity: Entity,
  previousVersion: string,
  currentVersion: string,
  token: string,
  templateFiles: Map<string, string>,
): Promise<PullRequestResult | null> {
  const providers = await getVcsProviders(
    vcsRegistry,
    templateSourceUrl,
    scaffoldedEntity,
    logger,
  );
  if (!providers) {
    return null;
  }

  try {
    const filesToUpdate = await getFilesToUpdate(
      urlReader,
      providers.scaffoldedUrl,
      templateFiles,
      logger,
      scaffoldedEntity.metadata.name,
    );
    if (!filesToUpdate) {
      return null;
    }

    return submitPullRequest(
      providers.scaffoldedProvider,
      scaffoldedEntity,
      providers.scaffoldedUrl,
      templateEntity,
      providers.templateUrlInfo,
      filesToUpdate,
      previousVersion,
      currentVersion,
      token,
      logger,
    );
  } catch (error) {
    logger.error(
      `Error creating template sync pull request for entity ${scaffoldedEntity.metadata.name}: ${error}`,
    );
    return null;
  }
}

/**
 * Handles template update pull requests by creating pull requests to sync template changes for each scaffolded entity
 *
 * @param catalogClient - Catalog client to fetch template entity
 * @param token - Auth token for catalog API
 * @param entityRef - Entity reference of the template
 * @param logger - Logger service
 * @param urlReader - UrlReaderService instance
 * @param vcsRegistry - VCS provider registry
 * @param config - Backstage config for SCM integrations
 * @param scaffoldedEntities - Array of scaffolded entities
 * @param previousVersion - Previous version of the template
 * @param currentVersion - Current version of the template
 * @returns Map of entity names to their created PR URLs
 *
 * @internal
 */
export async function handleTemplateUpdatePullRequest(
  catalogClient: CatalogClient,
  token: string,
  entityRef: string,
  logger: LoggerService,
  urlReader: UrlReaderService,
  vcsRegistry: VcsProviderRegistry,
  config: Config,
  scaffoldedEntities: Entity[],
  previousVersion: string,
  currentVersion: string,
): Promise<Map<string, string>> {
  const prResults = new Map<string, string>();

  const templateEntity = await catalogClient.getEntityByRef(entityRef, {
    token,
  });

  if (templateEntity) {
    const templateSourceUrl = extractTemplateSourceUrl(
      templateEntity,
      vcsRegistry,
      config,
      logger,
    );
    if (!templateSourceUrl) {
      logger.warn(
        `No template source URL found for template ${templateEntity.metadata.name}. Skipping PR creation.`,
      );
      return prResults;
    }

    let templateFiles: Map<string, string>;
    try {
      templateFiles = await fetchRepoFiles(urlReader, templateSourceUrl);
    } catch (error) {
      logger.error(
        `Error fetching template files for ${templateEntity.metadata.name}: ${error}. Skipping PR creation.`,
      );
      return prResults;
    }

    // Process each scaffolded entity with pre-fetched template files
    for (const entity of scaffoldedEntities) {
      const result = await createTemplateUpdatePullRequest(
        logger,
        urlReader,
        vcsRegistry,
        templateEntity,
        templateSourceUrl,
        entity,
        previousVersion,
        currentVersion,
        token,
        templateFiles,
      );

      if (result) {
        prResults.set(entity.metadata.name, result.url);
      }
    }
  }

  return prResults;
}
