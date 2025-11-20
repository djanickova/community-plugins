import { CatalogClient } from '@backstage/catalog-client';
import {
  createTemplateSyncPullRequest,
  extractTemplateSourceUrl,
  fetchRepoFiles,
} from '../pullRequestUtils';
import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';

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
export async function handleTemplateUpdatePullRequest(
  catalogClient: CatalogClient,
  token: string,
  entityRef: string,
  logger: LoggerService,
  urlReader: UrlReaderService,
  config: Config,
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
    const templateSourceUrl = extractTemplateSourceUrl(templateEntity);
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
        config,
        catalogClient,
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
