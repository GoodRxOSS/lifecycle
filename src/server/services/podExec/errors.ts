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

const messages = {
  exec_disabled: 'Pod shells are unavailable.',
  auth_required: 'Sign in to open a shell.',
  invalid_credential: 'Your session expired. Sign in again.',
  forbidden: 'You do not have access to this shell.',
  environment_unavailable: 'This Environment is no longer available.',
  environment_kind_not_supported: 'Shells are unavailable for this Environment.',
  namespace_not_supported: 'Shells require a dedicated Environment namespace.',
  pod_unavailable: 'This pod is no longer available.',
  build_tooling_excluded: 'Shells are unavailable for build tooling.',
  container_not_running: 'This container is not running.',
  target_changed: 'The container changed. Select it again to open a shell.',
  invalid_frame: 'The shell received an invalid message. Reconnect to retry.',
  auth_timeout: 'Authentication timed out. Reconnect to retry.',
  connect_timeout: 'The container took too long to respond. Reconnect to retry.',
  kubernetes_error: 'Could not reach Kubernetes. Reconnect to retry.',
  kubernetes_forbidden: 'Kubernetes denied access. Contact your platform team.',
  shell_start_failed: 'Could not start the selected shell. Check that it is installed in this container.',
  slow_client: 'Output exceeded the connection buffer. Reconnect to retry.',
  input_overflow: 'Input exceeded the connection buffer. Reconnect to retry.',
  connection_limit: 'Too many shells are open. Close a shell and retry.',
  idle_timeout: 'Shell disconnected after 10 minutes without input.',
  access_token_expired: 'Your session expired. Reconnect to continue.',
  server_draining: 'The server is restarting. Reconnect to continue.',
  connection_lost: 'Connection lost. Reconnect to continue.',
} as const;
export type ExecErrorCode = keyof typeof messages;
export class ExecError extends Error {
  constructor(public code: ExecErrorCode) {
    super(messages[code]);
  }
}
export function safeError(error: unknown, fallback: ExecErrorCode = 'kubernetes_error'): ExecError {
  return error instanceof ExecError ? error : new ExecError(fallback);
}

export function kubernetesReadError(error: unknown): ExecError {
  const response = error as { statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } };
  const status = response?.statusCode ?? response?.response?.statusCode ?? response?.body?.code;
  return new ExecError(
    status === 404 ? 'pod_unavailable' : status === 401 || status === 403 ? 'kubernetes_forbidden' : 'kubernetes_error'
  );
}
