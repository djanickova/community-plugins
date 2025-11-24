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

import { CatalogClient } from '@backstage/catalog-client';
import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { fetchRepoFiles } from './vcs/common';
import { fetchAndCompareFiles } from './comparison';
import { extractTemplateSourceUrl } from './template/entity';
import type { VcsProviderRegistry } from './vcs/VcsProviderRegistry';

/**
 * Creates a pull request to sync template changes with a scaffolded repository
 *
 * @param logger - Logger service
 * @param urlReader - UrlReaderService instance
 * @param vcsRegistry - VCS provider registry
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
async function createTemplateSyncPullRequest(
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
): Promise<void> {
  // Get the provider for the template URL
  const templateProvider = vcsRegistry.getProviderForUrl(templateSourceUrl);
  if (!templateProvider) {
    logger.debug(
      `No VCS provider found for template URL: ${templateSourceUrl}`,
    );
    return;
  }

  const templateUrlInfo = templateProvider.parseUrl(templateSourceUrl);
  if (!templateUrlInfo) {
    logger.debug(`Could not parse template URL: ${templateSourceUrl}`);
    return;
  }

  // Get the provider for the scaffolded entity
  const scaffoldedProvider = vcsRegistry.getProviderForEntity(scaffoldedEntity);
  if (!scaffoldedProvider) {
    logger.debug(
      `No VCS provider found for entity ${scaffoldedEntity.metadata.name}`,
    );
    return;
  }

  const scaffoldedUrl = scaffoldedProvider.extractRepoUrl(scaffoldedEntity);
  if (!scaffoldedUrl) {
    logger.debug(
      `Could not extract repository URL from entity ${scaffoldedEntity.metadata.name}`,
    );
    return;
  }

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
      name: templateEntity.metadata.title ?? templateEntity.metadata.name,
      previousVersion,
      currentVersion,
      componentName: scaffoldedEntity.metadata.name,
    };

    const reviewer = await scaffoldedProvider.getReviewerFromOwner(
      scaffoldedEntity,
      token,
    );

    await scaffoldedProvider.createPullRequest(
      scaffoldedUrl,
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

/**
 * Handles template update pull requests by creating pull requests to sync template changes for each scaffolded entity
 *
 * @param catalogClient - Catalog client to fetch template entity
 * @param token - Auth token for catalog API
 * @param entityRef - Entity reference of the template
 * @param logger - Logger service
 * @param urlReader - UrlReaderService instance
 * @param vcsRegistry - VCS provider registry
 * @param scaffoldedEntities - Array of scaffolded entities
 * @param previousVersion - Previous version of the template
 * @param currentVersion - Current version of the template
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
  scaffoldedEntities: Entity[],
  previousVersion: string,
  currentVersion: string,
) {
  // Get the template entity to extract source URL
  const templateEntity = await catalogClient.getEntityByRef(entityRef, {
    token,
  });

  // Create pull requests to sync template changes for each scaffolded entity
  if (templateEntity) {
    const templateSourceUrl = extractTemplateSourceUrl(
      templateEntity,
      vcsRegistry,
    );
    if (!templateSourceUrl) {
      logger.warn(
        `No template source URL found for template ${templateEntity.metadata.name}. Skipping PR creation.`,
      );
      return;
    }

    let templateFiles: Map<string, string>;
    try {
      templateFiles = await fetchRepoFiles(urlReader, templateSourceUrl);
    } catch (error) {
      logger.error(
        `Error fetching template files for ${templateEntity.metadata.name}: ${error}. Skipping PR creation.`,
      );
      return;
    }

    // Process each scaffolded entity with pre-fetched template files
    for (const entity of scaffoldedEntities) {
      await createTemplateSyncPullRequest(
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
    }
  }
}
