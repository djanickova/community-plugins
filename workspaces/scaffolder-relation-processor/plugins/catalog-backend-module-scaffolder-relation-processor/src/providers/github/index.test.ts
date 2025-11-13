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

import { Config } from '@backstage/config';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import { CatalogClient } from '@backstage/catalog-client';
import { mockServices } from '@backstage/backend-test-utils';
import {
  getGitHubClient,
  parseGitHubUrl,
  buildGitHubTreeUrl,
  getOwnerGitHubLogin,
  buildRepositoryUrl,
} from './index';
import { OctokitWithCreatePullRequest } from './types';

// Mock dependencies
jest.mock('@backstage/integration');
jest.mock('@octokit/core');
jest.mock('octokit-plugin-create-pull-request');
jest.mock('git-url-parse');

describe('github provider', () => {
  let mockConfig: Config;
  let mockLogger: ReturnType<typeof mockServices.logger.mock>;
  let mockCatalogClient: jest.Mocked<CatalogClient>;
  let mockOctokit: jest.Mocked<OctokitWithCreatePullRequest>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = mockServices.rootConfig();
    mockLogger = mockServices.logger.mock();
    mockCatalogClient = {
      getEntityByRef: jest.fn(),
    } as any as jest.Mocked<CatalogClient>;

    mockOctokit = {
      createPullRequest: jest.fn(),
      request: jest.fn(),
    } as any as jest.Mocked<OctokitWithCreatePullRequest>;
  });

  describe('getGitHubClient', () => {
    let mockIntegrations: jest.Mocked<ScmIntegrations>;
    let mockGithubIntegration: any;
    let mockCredentialsProvider: jest.Mocked<DefaultGithubCredentialsProvider>;

    beforeEach(() => {
      mockGithubIntegration = {
        config: {
          apiBaseUrl: 'https://api.github.com',
          token: 'fallback-token',
        },
      };

      mockIntegrations = {
        github: {
          byHost: jest.fn() as jest.MockedFunction<(host: string) => any>,
        },
      } as any;

      mockCredentialsProvider = {
        getCredentials: jest.fn(),
      } as any;

      (ScmIntegrations.fromConfig as jest.Mock) = jest
        .fn()
        .mockReturnValue(mockIntegrations);
      (DefaultGithubCredentialsProvider.fromIntegrations as jest.Mock) = jest
        .fn()
        .mockReturnValue(mockCredentialsProvider);
    });

    it('should return Octokit instance with createPullRequest plugin when credentials are available', async () => {
      const { Octokit } = require('@octokit/core');
      const {
        createPullRequest,
      } = require('octokit-plugin-create-pull-request');

      (mockIntegrations.github.byHost as jest.Mock).mockReturnValue(
        mockGithubIntegration,
      );
      mockCredentialsProvider.getCredentials.mockResolvedValue({
        token: 'test-token',
        type: 'token',
      });

      const mockOctokitInstance = {
        createPullRequest: jest.fn(),
      };
      const mockOctokitWithPlugin = jest
        .fn()
        .mockReturnValue(mockOctokitInstance);
      Octokit.plugin = jest.fn().mockReturnValue(mockOctokitWithPlugin);

      const result = await getGitHubClient(
        mockConfig,
        'https://github.com/owner/repo',
      );

      expect(ScmIntegrations.fromConfig).toHaveBeenCalledWith(mockConfig);
      expect(mockIntegrations.github.byHost).toHaveBeenCalledWith('github.com');
      expect(mockCredentialsProvider.getCredentials).toHaveBeenCalledWith({
        url: 'https://github.com/owner/repo',
      });
      expect(Octokit.plugin).toHaveBeenCalledWith(createPullRequest);
      expect(mockOctokitWithPlugin).toHaveBeenCalledWith({
        auth: 'test-token',
        baseUrl: 'https://api.github.com',
      });
      expect(result).toBe(mockOctokitInstance);
    });

    it('should use integration token as fallback when credentials provider returns no token', async () => {
      const { Octokit } = require('@octokit/core');
      require('octokit-plugin-create-pull-request');

      (mockIntegrations.github.byHost as jest.Mock).mockReturnValue(
        mockGithubIntegration,
      );
      mockCredentialsProvider.getCredentials.mockResolvedValue(null as any);

      const mockOctokitInstance = {
        createPullRequest: jest.fn(),
      };
      const mockOctokitWithPlugin = jest
        .fn()
        .mockReturnValue(mockOctokitInstance);
      Octokit.plugin = jest.fn().mockReturnValue(mockOctokitWithPlugin);

      const result = await getGitHubClient(
        mockConfig,
        'https://github.com/owner/repo',
      );

      expect(mockOctokitWithPlugin).toHaveBeenCalledWith({
        auth: 'fallback-token',
        baseUrl: 'https://api.github.com',
      });
      expect(result).toBe(mockOctokitInstance);
    });

    it('should return null when no GitHub integration is found', async () => {
      (mockIntegrations.github.byHost as jest.Mock).mockReturnValue(undefined);

      const result = await getGitHubClient(
        mockConfig,
        'https://github.com/owner/repo',
      );

      expect(result).toBeNull();
    });

    it('should return null when an error occurs', async () => {
      (ScmIntegrations.fromConfig as jest.Mock).mockImplementation(() => {
        throw new Error('Config error');
      });

      const result = await getGitHubClient(
        mockConfig,
        'https://github.com/owner/repo',
      );

      expect(result).toBeNull();
    });
  });

  describe('parseGitHubUrl', () => {
    it('should parse a standard GitHub HTTPS URL', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        source: 'github.com',
        owner: 'test-owner',
        name: 'test-repo',
        ref: 'main',
        filepath: 'path/to/file',
      });

      const result = parseGitHubUrl('https://github.com/test-owner/test-repo');

      expect(result).toEqual({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        path: 'path/to/file',
      });
    });

    it('should parse a GitHub URL with resource instead of source', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        resource: 'github.com',
        owner: 'test-owner',
        name: 'test-repo',
        ref: 'develop',
      });

      const result = parseGitHubUrl('https://github.com/test-owner/test-repo');

      expect(result).toEqual({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'develop',
        path: undefined,
      });
    });

    it('should return null for non-GitHub URLs', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        source: 'gitlab.com',
        owner: 'test-owner',
        name: 'test-repo',
      });

      const result = parseGitHubUrl('https://gitlab.com/test-owner/test-repo');

      expect(result).toBeNull();
    });

    it('should return null when owner is missing', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        source: 'github.com',
        name: 'test-repo',
      });

      const result = parseGitHubUrl('https://github.com/test-repo');

      expect(result).toBeNull();
    });

    it('should return null when repo name is missing', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        source: 'github.com',
        owner: 'test-owner',
      });

      const result = parseGitHubUrl('https://github.com/test-owner');

      expect(result).toBeNull();
    });

    it('should handle URLs without branch or path', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockReturnValue({
        source: 'github.com',
        owner: 'test-owner',
        name: 'test-repo',
      });

      const result = parseGitHubUrl('https://github.com/test-owner/test-repo');

      expect(result).toEqual({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: undefined,
        path: undefined,
      });
    });

    it('should return null when parsing fails', () => {
      const gitUrlParse = require('git-url-parse');
      gitUrlParse.mockImplementation(() => {
        throw new Error('Parse error');
      });

      const result = parseGitHubUrl('invalid-url');

      expect(result).toBeNull();
    });
  });

  describe('buildGitHubTreeUrl', () => {
    it('should build a GitHub tree URL without path', () => {
      const result = buildGitHubTreeUrl('owner', 'repo', 'main');

      expect(result).toBe('https://github.com/owner/repo/tree/main');
    });

    it('should build a GitHub tree URL with path', () => {
      const result = buildGitHubTreeUrl(
        'owner',
        'repo',
        'main',
        'path/to/file',
      );

      expect(result).toBe(
        'https://github.com/owner/repo/tree/main/path/to/file',
      );
    });

    it('should handle nested paths', () => {
      const result = buildGitHubTreeUrl(
        'owner',
        'repo',
        'develop',
        'src/components/Button',
      );

      expect(result).toBe(
        'https://github.com/owner/repo/tree/develop/src/components/Button',
      );
    });
  });

  describe('getOwnerGitHubLogin', () => {
    it('should return GitHub login for User entity with annotation', async () => {
      const mockUserEntity = {
        kind: 'User',
        metadata: {
          annotations: {
            'github.com/user-login': 'testuser',
          },
        },
      };

      mockCatalogClient.getEntityByRef.mockResolvedValue(mockUserEntity as any);

      const result = await getOwnerGitHubLogin(
        mockCatalogClient,
        'user:default/testuser',
        'token',
      );

      expect(mockCatalogClient.getEntityByRef).toHaveBeenCalledWith(
        'user:default/testuser',
        { token: 'token' },
      );
      expect(result).toBe('testuser');
    });

    it('should return null for User entity without GitHub annotation', async () => {
      const mockUserEntity = {
        kind: 'User',
        metadata: {
          annotations: {},
        },
      };

      mockCatalogClient.getEntityByRef.mockResolvedValue(mockUserEntity as any);

      const result = await getOwnerGitHubLogin(
        mockCatalogClient,
        'user:default/testuser',
        'token',
      );

      expect(result).toBeNull();
    });

    it('should return null for Group entity', async () => {
      const mockGroupEntity = {
        kind: 'Group',
        metadata: {
          annotations: {
            'github.com/user-login': 'testuser',
          },
        },
      };

      mockCatalogClient.getEntityByRef.mockResolvedValue(
        mockGroupEntity as any,
      );

      const result = await getOwnerGitHubLogin(
        mockCatalogClient,
        'group:default/testgroup',
        'token',
      );

      expect(result).toBeNull();
    });

    it('should return null when entity is not found', async () => {
      mockCatalogClient.getEntityByRef.mockResolvedValue(undefined);

      const result = await getOwnerGitHubLogin(
        mockCatalogClient,
        'user:default/nonexistent',
        'token',
      );

      expect(result).toBeNull();
    });
  });

  describe('buildRepositoryUrl', () => {
    it('should build repository URL with default branch', () => {
      const scaffoldedRepoInfo = {
        owner: 'owner',
        repo: 'repo',
      };

      const result = buildRepositoryUrl(scaffoldedRepoInfo);

      expect(result).toBe('https://github.com/owner/repo/tree/main');
    });

    it('should build repository URL with custom branch', () => {
      const scaffoldedRepoInfo = {
        owner: 'owner',
        repo: 'repo',
      };

      const result = buildRepositoryUrl(scaffoldedRepoInfo, 'develop');

      expect(result).toBe('https://github.com/owner/repo/tree/develop');
    });
  });
});
