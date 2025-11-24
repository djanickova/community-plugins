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

import { extractTemplateSourceUrl } from './entity';
import type { Entity } from '@backstage/catalog-model';
import type { VcsProviderRegistry } from '../vcs/VcsProviderRegistry';
import type { VcsProvider } from '../vcs/VcsProvider';

describe('extractTemplateSourceUrl', () => {
  const mockProvider: VcsProvider = {
    getName: () => 'mock',
    canHandle: () => true,
    extractRepoUrl: () =>
      'https://github.com/org/repo/tree/main/templates/template-a',
    parseUrl: () => null,
    createPullRequest: async () => {},
    getReviewerFromOwner: async () => null,
  };

  const mockRegistry = {
    registerProvider: jest.fn(),
    getProviderForUrl: jest.fn(),
    getProviderForEntity: jest.fn(() => mockProvider),
    getProviders: jest.fn(() => [mockProvider]),
  } as unknown as VcsProviderRegistry;

  it('should extract absolute URL from fetch:template action', () => {
    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: {
        name: 'test-template',
      },
      spec: {
        steps: [
          {
            action: 'fetch:template',
            input: {
              url: 'https://github.com/org/repo/tree/main/template',
            },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, mockRegistry);

    expect(result).toBe('https://github.com/org/repo/tree/main/template');
  });

  it('should resolve relative URL by combining with source location', () => {
    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: {
        name: 'test-template',
        annotations: {
          'backstage.io/source-location':
            'url:https://github.com/org/repo/tree/main/templates/template-a',
        },
      },
      spec: {
        steps: [
          {
            action: 'fetch:template',
            input: {
              url: './skeleton',
            },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, mockRegistry);

    expect(result).toBe(
      'https://github.com/org/repo/tree/main/templates/template-a/skeleton',
    );
  });

  it('should handle relative URL with trailing slash in base URL', () => {
    const providerWithTrailingSlash: VcsProvider = {
      ...mockProvider,
      extractRepoUrl: () => 'https://github.com/org/repo/tree/main/templates/',
    };

    const registryWithTrailingSlash = {
      ...mockRegistry,
      getProviderForEntity: jest.fn(() => providerWithTrailingSlash),
    } as unknown as VcsProviderRegistry;

    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'test-template' },
      spec: {
        steps: [
          {
            action: 'fetch:template',
            input: { url: './skeleton' },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, registryWithTrailingSlash);

    expect(result).toBe(
      'https://github.com/org/repo/tree/main/templates/skeleton',
    );
  });

  it('should return null when no steps are present', () => {
    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'test-template' },
      spec: {},
    };

    const result = extractTemplateSourceUrl(entity, mockRegistry);

    expect(result).toBeNull();
  });

  it('should return null when no fetch:template action is found', () => {
    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'test-template' },
      spec: {
        steps: [
          {
            action: 'debug:log',
            input: { message: 'test' },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, mockRegistry);

    expect(result).toBeNull();
  });

  it('should return null when relative URL but no provider found', () => {
    const registryWithNoProvider = {
      ...mockRegistry,
      getProviderForEntity: jest.fn(() => null),
    } as unknown as VcsProviderRegistry;

    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'test-template' },
      spec: {
        steps: [
          {
            action: 'fetch:template',
            input: { url: './skeleton' },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, registryWithNoProvider);

    expect(result).toBeNull();
  });

  it('should return null when relative URL but provider cannot extract base URL', () => {
    const providerWithNoUrl: VcsProvider = {
      ...mockProvider,
      extractRepoUrl: () => null,
    };

    const registryWithNoUrl = {
      ...mockRegistry,
      getProviderForEntity: jest.fn(() => providerWithNoUrl),
    } as unknown as VcsProviderRegistry;

    const entity: Entity = {
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'test-template' },
      spec: {
        steps: [
          {
            action: 'fetch:template',
            input: { url: './skeleton' },
          },
        ],
      },
    };

    const result = extractTemplateSourceUrl(entity, registryWithNoUrl);

    expect(result).toBeNull();
  });
});
