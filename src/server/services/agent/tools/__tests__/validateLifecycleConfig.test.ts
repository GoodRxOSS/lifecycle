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

import { ValidateLifecycleConfigTool } from '../lifecycle/validateLifecycleConfig';

describe('validate_lifecycle_config', () => {
  const tool = new ValidateLifecycleConfigTool();

  it('reports VALID for schema-valid content', async () => {
    const result = await tool.execute({
      content: 'version: "1.0.0"\nservices:\n  - name: web\n',
    });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('VALID');
    expect(result.agentContent).not.toContain('INVALID');
  });

  it('reports INVALID with path-specific errors and schema slices', async () => {
    const result = await tool.execute({
      content: 'version: "1.0.0"\nservices:\n  - name: web\n    bogusField: nope\n',
    });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('INVALID');
    expect(result.agentContent).toContain('bogusField');
    expect(result.agentContent).toContain('Relevant schema for the failing paths:');
  });

  it('rejects empty input with an instructive error', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('content is required');
  });
});
