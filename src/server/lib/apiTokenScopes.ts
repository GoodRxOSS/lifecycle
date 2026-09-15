import type { ApiTokenScope } from 'server/models/ApiToken';

export const API_TOKEN_SCOPES: ApiTokenScope[] = [
  'env:read',
  'env:write',
  'env:admin',
  'sites:read',
  'sites:write',
  'repos:read',
  'repos:write',
];

/** write ⊃ read within one resource; legacy env:admin covers env:* only; never cross-resource. */
export function scopeSatisfies(granted: readonly string[], required: ApiTokenScope): boolean {
  return granted.some((scope) => {
    if (!API_TOKEN_SCOPES.includes(scope as ApiTokenScope)) return false;
    if (scope === required) return true;
    if (scope === 'env:admin') return required === 'env:read' || required === 'env:write';
    const [resource, action] = scope.split(':');
    return action === 'write' && required === `${resource}:read`;
  });
}
