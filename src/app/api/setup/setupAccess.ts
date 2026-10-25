/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { V1Secret } from '@kubernetes/client-node';
import type { Knex } from 'knex';
import type { NextRequest } from 'next/server';
import { AppError, BadRequestError } from 'server/lib/appError';
import { getCurrentNamespaceFromFile, getK8sApi } from 'server/lib/kubernetes';
import { getLogger } from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';
import type { AppSetup } from 'server/services/types/globalConfig';
import {
  GITHUB_APP_ID,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET,
  LIFECYCLE_SETUP_TOKEN,
  SECRET_BOOTSTRAP_NAME,
} from 'shared/config';

const PLACEHOLDERS = new Set(['', 'your_value_here', 'not_setup', 'replace_me', 'changeme']);
const CREDENTIAL_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
] as const;
const FLOW_ANNOTATION = 'lifecycle.dev/setup-flow';
const URL_ANNOTATION = 'lifecycle.dev/setup-app-url';
const NAME_ANNOTATION = 'lifecycle.dev/setup-app-name';
const FINGERPRINT_ANNOTATION = 'lifecycle.dev/setup-credential-sha256';
const FLOW_TTL_MS = 60 * 60 * 1000;

export type SetupFlow = Partial<AppSetup> & {
  flowVersion?: 1;
  flowId?: string;
  phase?: 'manifest' | 'installation' | 'installed' | 'complete';
  expiresAt?: number;
  credentialFingerprint?: string;
};
export type BootstrapSecret = { body: V1Secret | null; values: Record<string, string> };

function real(value: unknown): boolean {
  return !PLACEHOLDERS.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
}
function equal(expected: string, presented: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(presented));
}
export function isEnvConfigured(): boolean {
  return [GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET].some(real);
}
export function hasCredentials(secret: BootstrapSecret): boolean {
  return CREDENTIAL_KEYS.some((key) => real(secret.values[key]));
}
export function credentialFingerprint(secret: BootstrapSecret): string {
  return createHash('sha256')
    .update(JSON.stringify(CREDENTIAL_KEYS.map((key) => secret.values[key] || '')))
    .digest('hex');
}
export function getSetupToken(): string {
  if (real(LIFECYCLE_SETUP_TOKEN)) return String(LIFECYCLE_SETUP_TOKEN).trim();
  const key = process.env.ENCRYPTION_KEY?.trim();
  if (real(key)) return createHmac('sha256', key!).update('lifecycle-setup-token').digest('hex').slice(0, 32);
  throw new AppError({
    httpStatus: 503,
    code: 'setup_token_unavailable',
    message: 'Configure a shared setup token before starting setup.',
  });
}
export function assertSetupActor(req: NextRequest): void {
  const presented = req.headers.get('x-setup-token');
  if (!presented)
    throw new AppError({
      httpStatus: 401,
      code: 'setup_token_required',
      message: 'Enter the setup token to continue.',
    });
  if (!equal(getSetupToken(), presented))
    throw new AppError({ httpStatus: 401, code: 'invalid_setup_token', message: 'That setup token is not valid.' });
}
export function setupLocked(): AppError {
  return new AppError({
    httpStatus: 403,
    code: 'setup_locked',
    message: 'GitHub App setup is locked. Manage the configured App through your installation settings.',
  });
}
export function newSetupState(): string {
  return randomBytes(24).toString('base64url');
}
export function activeFlow(flow: SetupFlow): boolean {
  return (
    flow.flowVersion === 1 &&
    !!flow.flowId &&
    Number.isFinite(flow.expiresAt) &&
    flow.expiresAt! > Date.now() &&
    flow.phase !== 'complete'
  );
}
export function assertSetupState(flow: SetupFlow, presented: string | null, phase: SetupFlow['phase']): void {
  if (!activeFlow(flow) || flow.phase !== phase || !flow.state || !presented || !equal(flow.state, presented)) {
    throw new BadRequestError('This GitHub link has expired or was used. Start setup again.', 'invalid_setup_state');
  }
}
export function nextFlow(flow: SetupFlow, phase: SetupFlow['phase']): SetupFlow {
  return {
    ...flow,
    flowVersion: 1,
    flowId: flow.flowId || newSetupState(),
    phase,
    state: newSetupState(),
    expiresAt: Date.now() + FLOW_TTL_MS,
  };
}
function bootstrapApi() {
  const api = getK8sApi();
  api.addInterceptor((options) => {
    options.timeout = 15_000;
  });
  return api;
}
export async function readBootstrapSecret(): Promise<BootstrapSecret> {
  try {
    const { body } = await bootstrapApi().readNamespacedSecret(SECRET_BOOTSTRAP_NAME, getCurrentNamespaceFromFile());
    return {
      body,
      values: Object.fromEntries(
        Object.entries(body.data || {}).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')])
      ),
    };
  } catch (error) {
    const status =
      (error as { response?: { statusCode?: number }; statusCode?: number }).response?.statusCode ??
      (error as { statusCode?: number }).statusCode;
    if (status === 404) return { body: null, values: {} };
    throw new AppError({
      httpStatus: 503,
      code: 'setup_state_unavailable',
      message: 'Lifecycle could not read its GitHub App settings. Try again.',
    });
  }
}
export async function writeBootstrapSecret(
  secret: BootstrapSecret,
  values: Record<string, string>,
  flow?: { id: string; url: string; name: string }
): Promise<void> {
  const body: V1Secret = {
    ...secret.body,
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      ...secret.body?.metadata,
      name: SECRET_BOOTSTRAP_NAME,
      ...(flow
        ? {
            annotations: {
              ...secret.body?.metadata?.annotations,
              [FLOW_ANNOTATION]: flow.id,
              [URL_ANNOTATION]: flow.url,
              [NAME_ANNOTATION]: flow.name,
              [FINGERPRINT_ANNOTATION]: credentialFingerprint({ body: null, values: { ...secret.values, ...values } }),
            },
          }
        : {}),
    },
    data: {
      ...secret.body?.data,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')])),
    },
  };
  try {
    const api = bootstrapApi();
    if (secret.body) await api.replaceNamespacedSecret(SECRET_BOOTSTRAP_NAME, getCurrentNamespaceFromFile(), body);
    else await api.createNamespacedSecret(getCurrentNamespaceFromFile(), body);
  } catch {
    throw new AppError({
      httpStatus: 503,
      code: 'setup_secret_write_failed',
      message: 'Lifecycle could not save the GitHub App settings. Retry this step.',
    });
  }
}
export function recoveredApp(flow: SetupFlow, secret: BootstrapSecret): { url: string; name: string } | null {
  const annotations = secret.body?.metadata?.annotations;
  if (
    flow.flowVersion !== 1 ||
    !flow.flowId ||
    flow.phase === 'complete' ||
    !hasCredentials(secret) ||
    annotations?.[FLOW_ANNOTATION] !== flow.flowId
  )
    return null;
  const fingerprint = credentialFingerprint(secret);
  if (
    annotations[FINGERPRINT_ANNOTATION] !== fingerprint ||
    (flow.credentialFingerprint && flow.credentialFingerprint !== fingerprint)
  )
    return null;
  if (!CREDENTIAL_KEYS.every((key) => real(secret.values[key]))) return null;
  const url = annotations[URL_ANNOTATION];
  if (!validGithubAppUrl(url)) return null;
  return { url, name: annotations[NAME_ANNOTATION] || '' };
}
export function validGithubAppUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/apps\/[a-zA-Z0-9-]+$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function assertCurrentApp(flow: SetupFlow, secret: BootstrapSecret): void {
  if (!recoveredApp(flow, secret) || flow.credentialFingerprint !== credentialFingerprint(secret)) throw setupLocked();
}
export async function withSetupTransaction<T>(
  action: (flow: SetupFlow, trx: Knex.Transaction, save: (flow: SetupFlow) => Promise<void>) => Promise<T>
): Promise<T> {
  const service = GlobalConfigService.getInstance();
  let changed = false;
  const result = await service.db.knex.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    await trx('global_config').insert({ key: 'app_setup', config: {} }).onConflict('key').ignore();
    const row = await trx('global_config').where({ key: 'app_setup' }).forUpdate().first();
    const flow = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as SetupFlow;
    return action(flow || {}, trx, async (next) => {
      await trx('global_config').where({ key: 'app_setup' }).update({ config: next });
      changed = true;
    });
  });
  if (changed) await service.invalidateCache().catch(() => getLogger().warn('Setup: config cache invalidation failed'));
  return result;
}
