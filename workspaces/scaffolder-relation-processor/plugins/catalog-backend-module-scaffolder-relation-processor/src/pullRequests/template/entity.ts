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

import type { Entity } from '@backstage/catalog-model';
import type { VcsProviderRegistry } from '../vcs/VcsProviderRegistry';

/**
 * Extracts the template source URL from a template entity
 *
 * @param templateEntity - The template entity
 * @param vcsRegistry - VCS provider registry to resolve URLs
 * @returns The source URL from the fetch:template action, or null if not found
 *
 * @internal
 */
export function extractTemplateSourceUrl(
  templateEntity: Entity,
  vcsRegistry: VcsProviderRegistry,
): string | null {
  const spec = templateEntity.spec as any;
  if (!spec?.steps || !Array.isArray(spec.steps)) {
    return null;
  }

  for (const step of spec.steps) {
    if (step.action === 'fetch:template' && step.input?.url) {
      const url = step.input.url;

      // If URL is relative (starts with './', eg. './skeleton'), combine with source location
      if (url.startsWith('./')) {
        // Try to get a VCS provider that can extract the base URL from the entity
        const provider = vcsRegistry.getProviderForEntity(templateEntity);
        if (!provider) {
          return null;
        }

        const baseUrl = provider.extractRepoUrl(templateEntity);
        if (!baseUrl) {
          return null;
        }

        const cleanBaseUrl = baseUrl.endsWith('/')
          ? baseUrl.slice(0, -1)
          : baseUrl;
        const relativePath = url.startsWith('./') ? url.substring(2) : url;

        return `${cleanBaseUrl}/${relativePath}`;
      }

      return url;
    }
  }

  return null;
}
