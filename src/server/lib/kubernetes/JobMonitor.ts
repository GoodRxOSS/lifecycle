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

import { shellPromise } from '../shell';
import { getLogger } from '../logger/index';

export interface JobStatus {
  logs: string;
  success: boolean;
  status?: 'succeeded' | 'failed' | 'superseded';
}

export interface MonitorOptions {
  timeoutSeconds?: number;
  logPrefix?: string;
  containerFilters?: string[];
}

export class JobMonitor {
  private static readonly DEFAULT_TIMEOUT = 1800; // 30 minutes
  private static readonly POLL_INTERVAL = 2000; // 2 seconds

  // eslint-disable-next-line no-unused-vars
  constructor(private readonly jobName: string, private readonly namespace: string) {}

  async waitForCompletion(options: MonitorOptions = {}): Promise<JobStatus> {
    const { timeoutSeconds = JobMonitor.DEFAULT_TIMEOUT, logPrefix, containerFilters } = options;

    const startTime = Date.now();
    let logs = '';

    try {
      // Wait for pod to be created
      const podName = await this.waitForPod(timeoutSeconds, startTime);

      // Wait for init containers
      await this.waitForInitContainers(podName, timeoutSeconds, startTime);

      // Get init container logs
      logs += await this.getInitContainerLogs(podName);

      // Wait for main containers to be ready
      await this.waitForMainContainers(podName, timeoutSeconds, startTime);

      // Get main container logs
      logs += await this.getMainContainerLogs(podName, containerFilters);

      // Wait for job completion
      await this.waitForJobCompletion();

      // Check final job status
      const { success, status } = await this.getJobStatus(logPrefix);

      return {
        logs,
        success,
        status,
      };
    } catch (error) {
      getLogger().error({ error }, `Job: monitor failed name=${this.jobName}`);
      return {
        logs: logs || `Job monitoring failed: ${error.message}`,
        success: false,
        status: 'failed',
      };
    }
  }

  private async waitForPod(timeoutSeconds: number, startTime: number): Promise<string> {
    let podName: string | null = null;

    while (!podName && Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        const pods = await shellPromise(
          `kubectl get pods -n ${this.namespace} -l job-name=${this.jobName} -o jsonpath='{.items[0].metadata.name}'`
        );
        if (pods.trim()) {
          podName = pods.trim();
          break;
        }
      } catch (error) {
        // Pod not ready yet, will retry
      }
      await this.sleep(JobMonitor.POLL_INTERVAL);
    }

    if (!podName) {
      throw new Error(`Pod for job ${this.jobName} was not created within timeout`);
    }

    return podName;
  }

  private async waitForInitContainers(podName: string, timeoutSeconds: number, startTime: number): Promise<void> {
    let initContainersReady = false;

    while (!initContainersReady && Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        const initContainerStatuses = await shellPromise(
          `kubectl get pod ${podName} -n ${this.namespace} -o jsonpath='{.status.initContainerStatuses}'`
        );

        if (initContainerStatuses && initContainerStatuses !== '[]') {
          const statuses = JSON.parse(initContainerStatuses);
          initContainersReady = statuses.every((status: any) => status.ready || status.state.terminated);
        } else {
          initContainersReady = true;
        }
      } catch (error) {
        // Init container status check failed, will retry
      }

      if (!initContainersReady) {
        await this.sleep(JobMonitor.POLL_INTERVAL);
      }
    }
  }

  private async getInitContainerLogs(podName: string): Promise<string> {
    let logs = '';

    try {
      const initContainerNames = await shellPromise(
        `kubectl get pod ${podName} -n ${this.namespace} -o jsonpath='{.spec.initContainers[*].name}'`
      );

      if (initContainerNames && initContainerNames.trim()) {
        const initNames = initContainerNames.split(' ').filter((name) => name);
        for (const initName of initNames) {
          try {
            const initLogs = await shellPromise(
              `kubectl logs -n ${this.namespace} ${podName} -c ${initName} --timestamps=true`
            );
            logs += `\n=== Init Container Logs (${initName}) ===\n${initLogs}\n`;
          } catch (err: any) {
            getLogger().debug(
              `K8s: init container logs failed container=${initName} error=${err.message || 'Unknown error'}`
            );
          }
        }
      }
    } catch (error: any) {
      getLogger().debug(`K8s: no init containers found pod=${podName} error=${error.message || 'Unknown error'}`);
    }

    return logs;
  }

  private async waitForMainContainers(podName: string, timeoutSeconds: number, startTime: number): Promise<void> {
    let allContainersReady = false;
    let retries = 0;
    const maxRetries = 30;

    while (!allContainersReady && retries < maxRetries && Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        const containerStatuses = await shellPromise(
          `kubectl get pod ${podName} -n ${this.namespace} -o jsonpath='{.status.containerStatuses}'`
        ).catch(() => '[]');

        if (containerStatuses && containerStatuses !== '[]') {
          const statuses = JSON.parse(containerStatuses);
          allContainersReady = statuses.every((status: any) => status.state.terminated || status.state.running);

          if (!allContainersReady) {
            const waiting = statuses.find((s: any) => s.state.waiting);
            if (waiting && waiting.state.waiting.reason) {
              getLogger().info(
                `Container: waiting name=${waiting.name} reason=${waiting.state.waiting.reason} message=${
                  waiting.state.waiting.message || 'no message'
                }`
              );
            }
          }
        }
      } catch (e) {
        // Container status check failed, will retry
      }

      if (!allContainersReady) {
        await this.sleep(JobMonitor.POLL_INTERVAL);
        retries++;
      }
    }
  }

  private async getMainContainerLogs(podName: string, containerFilters?: string[]): Promise<string> {
    let logs = '';
    let containerNames: string[] = [];

    try {
      const containersJson = await shellPromise(
        `kubectl get pod ${podName} -n ${this.namespace} -o jsonpath='{.spec.containers[*].name}'`
      );
      containerNames = containersJson.split(' ').filter((name) => name);

      // Apply filters if provided
      if (containerFilters && containerFilters.length > 0) {
        containerNames = containerNames.filter((name) => containerFilters.includes(name));
      }
    } catch (error) {
      getLogger().warn({ error }, `Container: names fetch failed`);
    }

    for (const containerName of containerNames) {
      try {
        const containerLog = await shellPromise(
          `kubectl logs -n ${this.namespace} ${podName} -c ${containerName} --timestamps=true`,
          { timeout: JobMonitor.DEFAULT_TIMEOUT * 1000 }
        );

        if (containerLog && containerLog.trim()) {
          logs += `\n=== Container Logs (${containerName}) ===\n${containerLog}\n`;
        }
      } catch (error: any) {
        getLogger().warn({ error }, `Container: logs fetch failed name=${containerName}`);
        logs += `\n=== Container Logs (${containerName}) ===\nError retrieving logs: ${error.message}\n`;
      }
    }

    return logs;
  }

  private async waitForJobCompletion(): Promise<void> {
    let jobCompleted = false;

    while (!jobCompleted) {
      try {
        const jobConditions = await shellPromise(
          `kubectl get job ${this.jobName} -n ${this.namespace} -o jsonpath='{.status.conditions}'`
        );

        if (jobConditions && jobConditions !== '[]') {
          const conditions = JSON.parse(jobConditions);
          jobCompleted = conditions.some(
            (condition: any) =>
              (condition.type === 'Complete' || condition.type === 'Failed') && condition.status === 'True'
          );
        }

        if (!jobCompleted) {
          await this.sleep(JobMonitor.POLL_INTERVAL);
        }
      } catch (error: any) {
        getLogger().debug(
          `Job status check failed for ${this.jobName}, will retry: ${error.message || 'Unknown error'}`
        );
        await this.sleep(JobMonitor.POLL_INTERVAL);
      }
    }
  }

  private async getJobStatus(
    logPrefix?: string
  ): Promise<{ success: boolean; status: 'succeeded' | 'failed' | 'superseded' }> {
    let success = false;
    let status: 'succeeded' | 'failed' | 'superseded' = 'failed';

    try {
      const jobStatus = await shellPromise(
        `kubectl get job ${this.jobName} -n ${this.namespace} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`
      );
      success = jobStatus.trim() === 'True';

      if (!success) {
        const failedStatus = await shellPromise(
          `kubectl get job ${this.jobName} -n ${this.namespace} -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}'`
        );

        if (failedStatus.trim() === 'True') {
          getLogger().error(`Job: failed name=${this.jobName}`);

          // Check if job was superseded
          try {
            const annotations = await shellPromise(
              `kubectl get job ${this.jobName} -n ${this.namespace} ` +
                `-o jsonpath='{.metadata.annotations.lifecycle\\.goodrx\\.com/termination-reason}'`
            );

            if (annotations === 'superseded-by-retry') {
              getLogger().info(`K8s: job superseded name=${this.jobName}`);
              success = true;
              status = 'superseded';
            }
          } catch (annotationError: any) {
            getLogger().debug(
              `K8s: supersession annotation check failed job=${this.jobName} error=${
                annotationError.message || 'Unknown error'
              }`
            );
          }
        }
      } else {
        status = 'succeeded';
      }
    } catch (error) {
      getLogger().error({ error }, `Job: status check failed name=${this.jobName}`);
    }

    return { success, status };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Static factory method for backward compatibility
  static async waitForJobAndGetLogs(
    jobName: string,
    namespace: string,
    logPrefixOrTimeout?: string | number,
    containerFilters?: string[]
  ): Promise<{ logs: string; success: boolean; status?: string }> {
    const monitor = new JobMonitor(jobName, namespace);

    const options: MonitorOptions = {};
    if (typeof logPrefixOrTimeout === 'number') {
      options.timeoutSeconds = logPrefixOrTimeout;
    } else if (typeof logPrefixOrTimeout === 'string') {
      options.logPrefix = logPrefixOrTimeout;
    }

    if (containerFilters) {
      options.containerFilters = containerFilters;
    }

    const result = await monitor.waitForCompletion(options);
    return {
      logs: result.logs,
      success: result.success,
      status: result.status,
    };
  }
}
