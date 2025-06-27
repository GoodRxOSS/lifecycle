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

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import {
  PageLayout,
  ErrorAlert,
  EmptyState,
  LoadingBox,
  LoadingSpinner,
  TerminalContainer,
  EmptyTerminalState,
  LogViewer,
  EventsViewer,
  JobHistoryTable,
  useWebSocketLogs,
  useJobPolling
} from '../../../../../components/logs';

interface BuildJobInfo {
  jobName: string;
  buildUuid: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  engine: 'buildkit' | 'kaniko' | 'unknown';
  error?: string;
  podName?: string;
}

interface BuildLogsListResponse {
  builds: BuildJobInfo[];
}

interface BuildLogStreamResponse {
  status: 'Active' | 'Complete' | 'Failed' | 'NotFound' | 'Pending';
  streamingRequired?: boolean;
  podName?: string | null;
  websocket?: {
    endpoint: string;
    parameters: {
      podName: string;
      namespace: string;
      follow: boolean;
      timestamps: boolean;
      container?: string;
    };
  };
  containers?: Array<{
    name: string;
    state: string;
  }>;
  message?: string;
  error?: string;
}

interface K8sEvent {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  source?: {
    component?: string;
    host?: string;
  };
}

export default function BuildLogsList() {
  const router = useRouter();
  const { uuid, name } = router.query;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [builds, setBuilds] = useState<BuildJobInfo[]>([]);

  const [selectedJob, setSelectedJob] = useState<BuildJobInfo | null>(null);
  const [jobInfo, setJobInfo] = useState<BuildLogStreamResponse | null>(null);
  const [activeContainer, setActiveContainer] = useState<string>('');
  const [loadingJob, setLoadingJob] = useState(false);

  const [showTimestamps, setShowTimestamps] = useState(true);

  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const {
    logsByContainer,
    connectingContainers,
    error: wsError,
    connectToContainer,
    closeAllConnections,
    setLogsByContainer
  } = useWebSocketLogs(showTimestamps, uuid as string);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      isMountedRef.current = false;
      closeAllConnections();
      document.body.style.overflow = originalOverflow;
    };
  }, [closeAllConnections]);

  useEffect(() => {
    if (wsError) {
      setError(wsError);
    }
  }, [wsError]);

  useEffect(() => {
    if (logContainerRef.current) {
      setTimeout(() => {
        if (logContainerRef.current) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight + 100;
        }
      }, 50);
    }
  }, [logsByContainer, activeContainer]);

  const fetchBuilds = async (silent = false) => {
    try {
      const response = await axios.get<BuildLogsListResponse>(
        `/api/v1/builds/${uuid}/services/${name}/buildLogs`
      );

      setBuilds(response.data.builds);
      setError(null);

      if (!selectedJob && response.data.builds.length > 0 && !silent) {
        handleJobSelect(response.data.builds[0]);
      }

      if (selectedJob) {
        const updatedJob = response.data.builds.find(b => b.jobName === selectedJob.jobName);
        if (updatedJob && updatedJob.status !== selectedJob.status) {
          setSelectedJob(updatedJob);
          if ((selectedJob.status === 'Active' || selectedJob.status === 'Pending') &&
            (updatedJob.status === 'Complete' || updatedJob.status === 'Failed')) {
            fetchJobInfo(updatedJob);
          }
        }
      }
    } catch (err: any) {
      if (!silent) {
        console.error('Error fetching builds:', err);
        setError(err.response?.data?.error || err.message || 'Failed to fetch builds');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const fetchJobInfo = async (job: BuildJobInfo) => {
    try {
      setLoadingJob(true);
      setError(null);
      setActiveContainer('');

      const response = await axios.get<BuildLogStreamResponse>(
        `/api/v1/builds/${uuid}/services/${name}/buildLogs/${job.jobName}`
      );

      setJobInfo(response.data);

      if (response.data.status !== 'NotFound' && response.data.status !== job.status) {
        if (response.data.status === 'Active' || response.data.status === 'Complete' ||
          response.data.status === 'Failed' || response.data.status === 'Pending') {
          const validStatus = response.data.status as BuildJobInfo['status'];
          setSelectedJob(prev => prev ? { ...prev, status: validStatus } : prev);
          setBuilds(prev => prev.map(b =>
            b.jobName === job.jobName ? { ...b, status: validStatus } : b
          ));
        }
      }

      if (response.data.status === 'NotFound') {
        setError(response.data.error || 'Job not found');
      } else {
        fetchJobEvents(job.jobName);

        if (response.data.containers && response.data.containers.length > 0) {
          const mainContainer = response.data.containers.find(c => c.name === 'buildkit' || c.name === 'kaniko') ||
            response.data.containers.find(c => !c.name.includes('init')) ||
            response.data.containers[0];
          setActiveContainer(mainContainer.name);
        }
      }
    } catch (err: any) {
      console.error('Error fetching job info:', err);
      setError(err.response?.data?.error || err.message || 'Failed to fetch job information');
    } finally {
      setLoadingJob(false);
    }
  };

  const fetchJobEvents = async (jobName: string) => {
    try {
      setEventsLoading(true);
      setEventsError(null);

      const response = await axios.get<{ events: K8sEvent[] }>(
        `/api/v1/builds/${uuid}/jobs/${jobName}/events`
      );

      setEvents(response.data.events);
    } catch (err: any) {
      console.error('Error fetching job events:', err);
      setEventsError(err.response?.data?.error || err.message || 'Failed to fetch events');
    } finally {
      setEventsLoading(false);
    }
  };

  const handleJobSelect = async (job: BuildJobInfo) => {
    closeAllConnections();

    setSelectedJob(job);
    setLogsByContainer({});
    setJobInfo(null);
    setActiveContainer('');
    setEvents([]);
    setEventsError(null);

    await fetchJobInfo(job);
  };

  useJobPolling({
    uuid: uuid as string,
    name: name as string,
    selectedJob,
    setSelectedJob: (job) => setSelectedJob(job),
    setJobs: (jobs) => setBuilds(jobs),
    fetchJobs: fetchBuilds,
    fetchJobInfo,
    onJobSelect: handleJobSelect
  });

  useEffect(() => {
    if (activeContainer && activeContainer !== 'events' && jobInfo) {
      connectToContainer(activeContainer, jobInfo);
    }
  }, [activeContainer, jobInfo, connectToContainer]);

  const handleTabChange = (containerName: string) => {
    setActiveContainer(containerName);
  };

  const getContainerDisplayName = (containerName: string): string => {
    if (containerName === 'git-clone') return 'Clone Repository';
    if (containerName === 'buildkit' || containerName === 'kaniko') return 'Build';
    if (containerName.includes('[init]')) return containerName;
    return containerName;
  };

  return (
    <PageLayout
      backLink={`/builds/${uuid}`}
      title="Build Logs"
      serviceName={name as string}
      environmentId={uuid as string}
    >
      {error && !selectedJob && <ErrorAlert error={error} />}

      {loading ? (
        <LoadingBox message="Loading builds..." />
      ) : builds.length === 0 ? (
        <EmptyState
          title="No builds found"
          description="No build jobs have been created for this service yet."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '600px 1fr', gap: '24px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <JobHistoryTable
            jobs={builds}
            selectedJob={selectedJob}
            onJobSelect={handleJobSelect}
            title="Build History"
            statusTextMap={{ Active: 'Building' }}
          />

          <div style={{
            backgroundColor: '#1a1a1a',
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '400px'
          }}>
            {selectedJob ? (
              <TerminalContainer
                jobName={selectedJob.jobName}
                containers={jobInfo?.containers}
                activeContainer={activeContainer}
                onTabChange={handleTabChange}
                connectingContainers={connectingContainers}
                getContainerDisplayName={getContainerDisplayName}
                showTimestamps={showTimestamps}
                onTimestampsToggle={() => setShowTimestamps(!showTimestamps)}
              >
                {loadingJob ? (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: '#666'
                  }}>
                    <LoadingSpinner size={24} />
                    <span style={{ marginLeft: '12px' }}>Loading logs...</span>
                  </div>
                ) : activeContainer === 'events' ? (
                  <EventsViewer
                    events={events}
                    loading={eventsLoading}
                    error={eventsError}
                  />
                ) : (
                  <LogViewer
                    logs={logsByContainer[activeContainer] || []}
                    isConnecting={connectingContainers.includes(activeContainer)}
                    containerRef={logContainerRef}
                    showTimestamps={showTimestamps}
                    containerState={jobInfo?.containers?.find(c => c.name === activeContainer)?.state}
                  />
                )}
              </TerminalContainer>
            ) : (
              <EmptyTerminalState type="build" />
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
}