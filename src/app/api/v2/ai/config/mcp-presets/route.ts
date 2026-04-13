/**
 * Copyright 2026 GoodRx, Inc.
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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse } from 'server/lib/response';
import { listMcpPresets } from 'server/services/ai/mcp/presets';

/**
 * @openapi
 * /api/v2/ai/config/mcp-presets:
 *   get:
 *     summary: List MCP presets
 *     description: Returns MCP preset metadata for the admin MCP editor.
 *     tags:
 *       - MCP Server Config
 *     operationId: listMcpPresets
 *     responses:
 *       '200':
 *         description: List of MCP presets
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListMcpPresetsSuccessResponse'
 */
const getHandler = async (req: NextRequest) => {
  return successResponse(listMcpPresets(), { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
