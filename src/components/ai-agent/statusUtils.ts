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

export function getStatusColor(status: string): 'success' | 'danger' | 'warning' | 'default' {
  if (!status) return 'default';
  const normalized = status.toLowerCase().replace(/_/g, '');
  switch (normalized) {
    case 'ready':
      return 'success';
    case 'buildfailed':
    case 'error':
      return 'danger';
    case 'deployfailed':
      return 'warning';
    default:
      return 'default';
  }
}

export function getStatusLabel(status: string): string {
  if (!status) return 'Unknown';
  const lower = status.toLowerCase();
  switch (lower) {
    case 'ready':
      return 'Healthy';
    case 'build_failed':
      return 'Build Failed';
    case 'deploy_failed':
      return 'Deploy Failed';
    case 'error':
      return 'Error';
    default:
      return status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
