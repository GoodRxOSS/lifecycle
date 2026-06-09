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

import { randomBytes } from 'crypto';
import { decrypt, encrypt, isEncryptionKeyConfigured } from 'server/lib/encryption';

/** Env var (and per-session secret key) the workspace gateway reads to enforce bearer auth. */
export const LIFECYCLE_GATEWAY_TOKEN_ENV = 'LIFECYCLE_GATEWAY_TOKEN';
/** Proxy-safe request header for the workspace gateway token. Some proxies reserve Authorization. */
export const LIFECYCLE_GATEWAY_TOKEN_HEADER = 'x-lifecycle-gateway-token';

export function mintWorkspaceGatewayToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * K8s gateway token: minted + encrypted only when ENCRYPTION_KEY is configured. On keyless installs
 * the cluster-internal gateway runs without bearer enforcement (D9 allows "unset env ⇒ no enforcement"
 * on K8s as rollback safety), so we skip minting rather than bricking session provisioning. Remote
 * backends mint unconditionally — their gateway URLs are public.
 */
export function mintKubernetesGatewayToken(): { gatewayToken?: string; encryptedGatewayToken?: string } {
  if (!isEncryptionKeyConfigured()) {
    return {};
  }
  const gatewayToken = mintWorkspaceGatewayToken();
  return { gatewayToken, encryptedGatewayToken: encryptWorkspaceGatewayToken(gatewayToken) };
}

export function encryptWorkspaceGatewayToken(token: string): string {
  return encrypt(token);
}

export function decryptWorkspaceGatewayToken(ciphertext: string): string {
  try {
    return decrypt(ciphertext);
  } catch {
    // Never send a garbled value upstream as a credential.
    throw new Error(
      'Workspace gateway token could not be decrypted; verify ENCRYPTION_KEY matches the key used when this workspace was provisioned.'
    );
  }
}

export function buildWorkspaceGatewayAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    [LIFECYCLE_GATEWAY_TOKEN_HEADER]: token,
  };
}

/**
 * Session secrets (GitHub token, provider credentialEnv, MCP config) for snapshot-recreate backends:
 * persisted ENCRYPTED in providerState and re-injected as create-time env on resume, so nothing
 * sensitive is baked into the filesystem snapshot image at rest.
 */
export function encryptSessionSecretEnv(env: Record<string, string>): string {
  return encrypt(JSON.stringify(env));
}

export function decryptSessionSecretEnv(ciphertext: string): Record<string, string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decrypt(ciphertext));
  } catch {
    throw new Error(
      'Workspace session secrets could not be decrypted; verify ENCRYPTION_KEY matches the key used when this workspace was provisioned.'
    );
  }
  const env: Record<string, string> = {};
  if (decoded && typeof decoded === 'object') {
    for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
  }
  return env;
}
