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

import { useEffect, useRef } from 'react';

interface JobInfo {
  jobName: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
}

interface UseJobPollingProps<T extends JobInfo> {
  uuid: string | string[] | undefined;
  name: string | string[] | undefined;
  selectedJob: T | null;
  // eslint-disable-next-line no-unused-vars
  setSelectedJob: (job: T | null) => void;
  // eslint-disable-next-line no-unused-vars
  setJobs?: (jobs: T[]) => void;
  // eslint-disable-next-line no-unused-vars
  fetchJobs: (silent?: boolean) => Promise<void>;
  // eslint-disable-next-line no-unused-vars
  fetchJobInfo: (job: T) => Promise<void>;
  // eslint-disable-next-line no-unused-vars
  onJobSelect: (job: T) => Promise<void>;
  pollingInterval?: number; // in milliseconds, default 3000
}

export function useJobPolling<T extends JobInfo>({
  uuid,
  name,
  selectedJob,
  setSelectedJob,
  fetchJobs,
  fetchJobInfo,
  onJobSelect,
  pollingInterval = 3000,
}: UseJobPollingProps<T>) {
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (uuid && name) {
      fetchJobs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, name]);

  useEffect(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    pollingIntervalRef.current = setInterval(() => {
      fetchJobs(true);
    }, pollingInterval);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, name, pollingInterval]);

  const handleJobUpdate = (jobs: T[]) => {
    if (selectedJob) {
      const updatedJob = jobs.find((j) => j.jobName === selectedJob.jobName);
      if (updatedJob && updatedJob.status !== selectedJob.status) {
        setSelectedJob(updatedJob);
        if (
          (selectedJob.status === 'Active' || selectedJob.status === 'Pending') &&
          (updatedJob.status === 'Complete' || updatedJob.status === 'Failed')
        ) {
          fetchJobInfo(updatedJob);
        }
      }
    }
  };

  const handleInitialJobSelect = (jobs: T[]) => {
    if (!selectedJob && jobs.length > 0) {
      onJobSelect(jobs[0]);
    }
  };

  return {
    handleJobUpdate,
    handleInitialJobSelect,
    pollingIntervalRef,
  };
}
