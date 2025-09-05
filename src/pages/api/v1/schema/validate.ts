/**
 * Copyright 2025 GoodRx, Inc.
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

/**
 * @openapi
 * /api/v1/schema/validate:
 *   post:
 *     summary: Validate YAML configuration
 *     description: Validates a YAML config provided as content or fetched from a repo/branch.
 *     tags:
 *       - Schema
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source:
 *                 type: string
 *                 enum: [content, path]
 *               content:
 *                 type: string
 *                 description: Base64-encoded YAML content (required if source=content)
 *               repo:
 *                 type: string
 *                 description: Repository name (required if source=path)
 *               branch:
 *                 type: string
 *                 description: Branch name (required if source=path)
 *     responses:
 *       200:
 *         description: Validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 error:
 *                   type: array
 *                   items:
 *                     type: string
 *                   nullable: true
 *       400:
 *         description: Bad request or validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 error:
 *                   type: array
 *                   items:
 *                     type: string
 *                   nullable: true
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */

type ValidationResponse = {
  valid: boolean;
  error: string[] | null;
};

type ErrorResponse = {
  error: string;
};

type Response = ValidationResponse | ErrorResponse;

import { NextApiRequest, NextApiResponse } from 'next/types';
import { getYamlFileContentFromBranch } from 'server/lib/github';
import rootLogger from 'server/lib/logger';
import { YamlConfigParser, ParsingError } from 'server/lib/yamlConfigParser';
import { YamlConfigValidator, ValidationError } from 'server/lib/yamlConfigValidator';

const logger = rootLogger.child({
  filename: 'v1/schema/validate',
});

const schemaValidateHandler = async (req: NextApiRequest, res: NextApiResponse<Response>) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { source } = req.body;
  const allowedSources = ['content', 'path'];

  if (!source || typeof source !== 'string' || !allowedSources.includes(source)) {
    return res.status(400).json({ valid: false, error: ['Invalid source in request body'] });
  }

  try {
    if (source === 'content') {
      return await validateContent(req, res);
    } else if (source === 'path') {
      return await validatePath(req, res);
    }
  } catch (error) {
    if (error instanceof ParsingError || error instanceof ValidationError) {
      const errors = error.message.split('\n');
      return res.status(400).json({ valid: false, error: errors });
    }
    logger.error({ err: error }, 'Unexpected error during YAML validation');
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export default schemaValidateHandler;

const validateContent = async (req: NextApiRequest, res: NextApiResponse<Response>) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ valid: false, error: ['Invalid content in request body'] });
  }
  const decodedContent = Buffer.from(content, 'base64').toString('utf-8');
  const parser = new YamlConfigParser();
  const config = parser.parseYamlConfigFromString(decodedContent);
  const isValid = new YamlConfigValidator().validate(config?.version, config);
  return res.status(200).json({ valid: isValid, error: null });
};

const validatePath = async (req: NextApiRequest, res: NextApiResponse<Response>) => {
  const { repo, branch } = req.body;
  if (![repo, branch].every((val) => typeof val === 'string' && val.trim() !== '')) {
    return res.status(400).json({ valid: false, error: ['Invalid repo or branch in request body'] });
  }
  const content = (await getYamlFileContentFromBranch(repo, branch)) as string;
  const parser = new YamlConfigParser();
  const config = parser.parseYamlConfigFromString(content);
  const isValid = new YamlConfigValidator().validate(config?.version, config);
  return res.status(200).json({ valid: isValid, error: null });
};
