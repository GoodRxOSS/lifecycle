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

import { createHash } from 'crypto';
import { generateSecretName } from 'server/lib/kubernetes/secretNames';
import { containsSecretRefTemplate, parseSecretRef, SecretRef, SecretRefWithEnvKey } from 'server/lib/secretRefs';

export const HELM_SECRET_MOUNT_ROOT = '/var/run/lifecycle/helm-secrets';

export interface HelmValueSecretRef extends SecretRefWithEnvKey {
  helmKey: string;
}

export interface HelmSecretSetFile {
  helmKey: string;
  secretName: string;
  secretKey: string;
  mountPath: string;
  provider: string;
}

export interface HelmSecretValueRefsResult {
  plainValues: string[];
  secretRefs: HelmValueSecretRef[];
  secretSetFiles: HelmSecretSetFile[];
}

function shortHash(value: string, length = 10): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length);
}

function sanitizeSecretKeyPart(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');

  return sanitized || 'value';
}

export function formatSecretRef(ref: SecretRef): string {
  return `{{${ref.provider}:${ref.path}${ref.key ? `:${ref.key}` : ''}}}`;
}

export function generateHelmSecretKey(helmKey: string, ref: SecretRef): string {
  const sanitizedHelmKey = sanitizeSecretKeyPart(helmKey).slice(0, 120);
  const hash = shortHash(`${helmKey}\n${ref.provider}\n${ref.path}\n${ref.key || ''}`);

  return `helm.${sanitizedHelmKey}.${hash}`;
}

export function splitHelmSecretValueRefs(values: string[], serviceName: string): HelmSecretValueRefsResult {
  const plainValues: string[] = [];
  const secretRefs: HelmValueSecretRef[] = [];
  const secretSetFiles: HelmSecretSetFile[] = [];

  values.forEach((value) => {
    const equalIndex = value.indexOf('=');

    if (equalIndex === -1) {
      if (containsSecretRefTemplate(value)) {
        throw new Error(`Helm custom value '${value}' contains a secret ref but is not a key=value entry`);
      }

      plainValues.push(value);
      return;
    }

    const helmKey = value.substring(0, equalIndex);
    const helmValue = value.substring(equalIndex + 1);
    const secretRef = parseSecretRef(helmValue);

    if (!secretRef) {
      if (containsSecretRefTemplate(helmValue)) {
        throw new Error(`Helm custom value '${helmKey}' uses unsupported partial or malformed secret interpolation`);
      }

      plainValues.push(value);
      return;
    }

    const secretKey = generateHelmSecretKey(helmKey, secretRef);
    const secretName = generateSecretName(serviceName, secretRef.provider);

    secretRefs.push({
      envKey: secretKey,
      helmKey,
      ...secretRef,
    });
    secretSetFiles.push({
      helmKey,
      secretName,
      secretKey,
      provider: secretRef.provider,
      mountPath: `${HELM_SECRET_MOUNT_ROOT}/${secretName}/${secretKey}`,
    });
  });

  return { plainValues, secretRefs, secretSetFiles };
}

export function assertNoHelmSecretValueRefs(values: string[], deployPath: string): void {
  let result: HelmSecretValueRefsResult;

  try {
    result = splitHelmSecretValueRefs(values, 'unsupported-helm-secret-refs');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${deployPath} does not support helm.chart.values secret refs: ${message}`);
  }

  if (result.secretRefs.length > 0) {
    const refs = result.secretRefs.map((ref) => `${ref.helmKey}=${formatSecretRef(ref)}`).join(', ');
    throw new Error(`${deployPath} does not support helm.chart.values secret refs: ${refs}`);
  }
}

export function buildHelmSecretVolumeName(secretName: string): string {
  const hash = shortHash(secretName, 8);
  const sanitized = secretName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);

  return `helm-secret-${sanitized || 'secret'}-${hash}`;
}

export function buildHelmSecretVolumes(secretSetFiles: HelmSecretSetFile[]): any[] {
  const filesBySecret = new Map<string, Set<string>>();

  secretSetFiles.forEach((file) => {
    if (!filesBySecret.has(file.secretName)) {
      filesBySecret.set(file.secretName, new Set());
    }

    filesBySecret.get(file.secretName)!.add(file.secretKey);
  });

  return Array.from(filesBySecret.entries()).map(([secretName, secretKeys]) => ({
    name: buildHelmSecretVolumeName(secretName),
    secret: {
      secretName,
      items: Array.from(secretKeys).map((secretKey) => ({ key: secretKey, path: secretKey })),
    },
  }));
}

export function buildHelmSecretVolumeMounts(secretSetFiles: HelmSecretSetFile[]): any[] {
  const secretNames = Array.from(new Set(secretSetFiles.map((file) => file.secretName)));

  return secretNames.map((secretName) => ({
    name: buildHelmSecretVolumeName(secretName),
    mountPath: `${HELM_SECRET_MOUNT_ROOT}/${secretName}`,
    readOnly: true,
  }));
}
