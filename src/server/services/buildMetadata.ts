/**
 * Copyright 2026 Lifecycle contributors
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

import * as mustache from 'mustache';
import { nanoid } from 'nanoid';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { getLogger } from 'server/lib/logger';
import { Build } from 'server/models';
import BaseService from './_service';
import GlobalConfigService from './globalConfig';
import type { BuildMetadataConfig, BuildMetadataLink } from './types/globalConfig';

export const BUILD_METADATA_CONFIG_KEY = 'metadata';
export type { BuildMetadataConfig, BuildMetadataLink } from './types/globalConfig';

const UNSAFE_URL_PROTOCOLS = new Set(['javascript:', 'data:']);
const LINK_ID_PREFIX = 'metadata-link';

export class BuildMetadataError extends Error {
  constructor(message: string, public code: 'invalid_input' | 'not_found' | 'invalid_rendered_link') {
    super(message);
    this.name = 'BuildMetadataError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BuildMetadataError(`${fieldName} must be a string.`, 'invalid_input');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BuildMetadataError(`${fieldName} must not be empty.`, 'invalid_input');
  }

  return trimmed;
}

function readOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStringField(value, fieldName);
}

function readPosition(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BuildMetadataError('position must be an integer.', 'invalid_input');
  }

  return value;
}

function assertSafeUrlScheme(link: string): void {
  const protocolMatch = link.trim().match(/^([a-z][a-z0-9+.-]*):/i);
  const protocol = protocolMatch?.[1]?.toLowerCase();
  if (protocol && UNSAFE_URL_PROTOCOLS.has(`${protocol}:`)) {
    throw new BuildMetadataError(`Unsupported metadata link scheme: ${protocol}:`, 'invalid_input');
  }
}

function validateRenderedUrl(link: string, id: string): string {
  const trimmed = link.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BuildMetadataError(`Rendered metadata link '${id}' must be a valid URL.`, 'invalid_rendered_link');
  }

  if (UNSAFE_URL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new BuildMetadataError(
      `Rendered metadata link '${id}' uses an unsupported URL scheme.`,
      'invalid_rendered_link'
    );
  }

  return trimmed;
}

function renderLinkTemplate(template: string, context: Record<string, unknown>): string {
  const unescapedTemplate = template.replace(/{{{?([^{}]*?)}}}?/g, '{{{$1}}}');
  return mustache.render(unescapedTemplate, context);
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export default class BuildMetadataService extends BaseService {
  private globalConfig = GlobalConfigService.getInstance();

  private sortLinks(links: BuildMetadataLink[]): BuildMetadataLink[] {
    return [...links].sort((left, right) => left.position - right.position || left.text.localeCompare(right.text));
  }

  private normalizeConfig(value: unknown): BuildMetadataConfig {
    if (!isObject(value) || !Array.isArray(value.links)) {
      return { links: [] };
    }

    const links = value.links.flatMap((link): BuildMetadataLink[] => {
      if (!isObject(link)) {
        return [];
      }

      const { id, text, icon, link: href, position } = link;
      if (
        typeof id !== 'string' ||
        typeof text !== 'string' ||
        typeof icon !== 'string' ||
        typeof href !== 'string' ||
        typeof position !== 'number' ||
        !Number.isInteger(position)
      ) {
        return [];
      }

      return [{ id, text, icon, link: href, position }];
    });

    return { links: this.sortLinks(links) };
  }

  private async loadConfig(): Promise<BuildMetadataConfig> {
    return this.normalizeConfig(await this.globalConfig.getConfig(BUILD_METADATA_CONFIG_KEY));
  }

  private async saveConfig(config: BuildMetadataConfig): Promise<BuildMetadataConfig> {
    const normalized = this.normalizeConfig(config);
    await this.globalConfig.setConfig(BUILD_METADATA_CONFIG_KEY, normalized);
    return normalized;
  }

  private nextPosition(links: BuildMetadataLink[]): number {
    if (links.length === 0) {
      return 0;
    }

    return Math.max(...links.map((link) => link.position)) + 1;
  }

  private validateAllowedFields(input: Record<string, unknown>, allowedFields: Set<string>): void {
    const unsupportedFields = Object.keys(input).filter((field) => !allowedFields.has(field));
    if (unsupportedFields.length > 0) {
      throw new BuildMetadataError(
        `Unsupported metadata link fields: ${unsupportedFields.join(', ')}`,
        'invalid_input'
      );
    }
  }

  private readCreateInput(input: unknown, position: number): Omit<BuildMetadataLink, 'id'> {
    if (!isObject(input)) {
      throw new BuildMetadataError('Request body must be an object.', 'invalid_input');
    }

    this.validateAllowedFields(input, new Set(['text', 'icon', 'link', 'position']));

    const link = readStringField(input.link, 'link');
    assertSafeUrlScheme(link);

    return {
      text: readStringField(input.text, 'text'),
      icon: readStringField(input.icon, 'icon'),
      link,
      position: readPosition(input.position, position),
    };
  }

  private readPatchInput(input: unknown): Partial<Omit<BuildMetadataLink, 'id'>> {
    if (!isObject(input)) {
      throw new BuildMetadataError('Request body must be an object.', 'invalid_input');
    }

    this.validateAllowedFields(input, new Set(['text', 'icon', 'link', 'position']));

    const patch: Partial<Omit<BuildMetadataLink, 'id'>> = {};
    const text = readOptionalStringField(input.text, 'text');
    const icon = readOptionalStringField(input.icon, 'icon');
    const link = readOptionalStringField(input.link, 'link');

    if (text !== undefined) {
      patch.text = text;
    }
    if (icon !== undefined) {
      patch.icon = icon;
    }
    if (link !== undefined) {
      assertSafeUrlScheme(link);
      patch.link = link;
    }
    if (input.position !== undefined) {
      patch.position = readPosition(input.position, 0);
    }

    if (Object.keys(patch).length === 0) {
      throw new BuildMetadataError('Request body must include at least one supported field.', 'invalid_input');
    }

    return patch;
  }

  async getConfig(): Promise<BuildMetadataConfig> {
    return this.loadConfig();
  }

  async createLink(input: unknown): Promise<BuildMetadataConfig> {
    const config = await this.loadConfig();
    const link = this.readCreateInput(input, this.nextPosition(config.links));

    return this.saveConfig({
      links: [
        ...config.links,
        {
          id: `${LINK_ID_PREFIX}-${nanoid(10)}`,
          ...link,
        },
      ],
    });
  }

  async updateLink(id: string, input: unknown): Promise<BuildMetadataConfig> {
    const config = await this.loadConfig();
    const linkIndex = config.links.findIndex((link) => link.id === id);
    if (linkIndex === -1) {
      throw new BuildMetadataError(`Metadata link '${id}' not found.`, 'not_found');
    }

    const patch = this.readPatchInput(input);
    const links = [...config.links];
    links[linkIndex] = { ...links[linkIndex], ...patch };

    return this.saveConfig({ links });
  }

  async deleteLink(id: string): Promise<void> {
    const config = await this.loadConfig();
    const links = config.links.filter((link) => link.id !== id);
    if (links.length === config.links.length) {
      throw new BuildMetadataError(`Metadata link '${id}' not found.`, 'not_found');
    }

    await this.saveConfig({ links });
  }

  async renderMetadataForBuild(build: Build): Promise<BuildMetadataConfig> {
    const config = await this.loadConfig();
    if (config.links.length === 0) {
      return { links: [] };
    }

    const context = await new BuildEnvironmentVariables(this.db).availableEnvironmentVariablesForBuild(build, {
      applyNoDefaultEnvResolveFeatureFlag: false,
    });

    return {
      links: this.sortLinks(config.links).map((link) => {
        const renderedLink = renderLinkTemplate(link.link, context);
        return {
          ...link,
          link: validateRenderedUrl(renderedLink, link.id),
        };
      }),
    };
  }

  async renderMetadataForBuildUUID(uuid: string): Promise<BuildMetadataConfig> {
    const build = await this.db.models.Build.query()
      .findOne({ uuid })
      .select('id', 'uuid', 'sha', 'namespace', 'enableFullYaml', 'runUUID');

    if (!build) {
      throw new BuildMetadataError(`Build with UUID ${uuid} not found.`, 'not_found');
    }

    return this.renderMetadataForBuild(build);
  }

  async renderDashboardMarkdown(build: Build): Promise<string> {
    const metadata = await this.renderMetadataForBuild(build);
    if (metadata.links.length === 0) {
      return '';
    }

    let message = '<details>\n';
    message += '<summary>Dashboards</summary>\n\n';
    message += '|| Links |\n';
    message += '| ------------- | ------------- |\n';
    metadata.links.forEach((link) => {
      message += `| ${markdownTableCell(link.text)} | ${markdownTableCell(link.link)} |\n`;
    });
    message += '</details>\n';

    return message;
  }

  logRenderFailure(error: unknown): void {
    getLogger().error({ error }, 'Metadata: render failed');
  }
}
