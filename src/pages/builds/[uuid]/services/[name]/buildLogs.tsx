import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  formatDuration,
  formatTimestamp,
  EventsViewer
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

type LogMessage = {
  type: 'log' | 'error' | 'end';
  payload?: string;
  message?: string;
};

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
  const [logsByContainer, setLogsByContainer] = useState<Record<string, string[]>>({});
  const [, setSocketsByContainer] = useState<Record<string, WebSocket | null>>({});
  const [connectingContainers, setConnectingContainers] = useState<string[]>([]);
  const [loadingJob, setLoadingJob] = useState(false);

  const [showTimestamps, setShowTimestamps] = useState(true);

  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      isMountedRef.current = false;
      closeAllConnections();
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      document.body.style.overflow = originalOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (uuid && name) {
      fetchBuilds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, name]);

  // Lightweight polling to check for new jobs only
  useEffect(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    // Poll every 3 seconds to check for new jobs
    pollingIntervalRef.current = setInterval(() => {
      fetchBuilds(true); // silent fetch - no loading state
    }, 3000);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, name]);


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
        // Always fetch events for any job
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

  const closeAllConnections = useCallback(() => {
    setSocketsByContainer(prev => {
      Object.values(prev).forEach(socket => {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      });
      return {};
    });
  }, []);

  const connectToContainer = useCallback((containerName: string) => {
    if (!jobInfo || !isMountedRef.current) return;

    if (!jobInfo.websocket && !jobInfo.podName) return;

    setSocketsByContainer(prev => {
      if (prev[containerName] && prev[containerName]?.readyState !== WebSocket.CLOSED) {
        prev[containerName]?.close();
      }
      return { ...prev, [containerName]: null };
    });

    if (isMountedRef.current) {
      setConnectingContainers(prev => [...prev, containerName]);
      setLogsByContainer(prev => ({
        ...prev,
        [containerName]: []
      }));
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    const params = new URLSearchParams();

    if (jobInfo.websocket) {
      params.append('podName', jobInfo.websocket.parameters.podName);
      params.append('namespace', jobInfo.websocket.parameters.namespace);
      params.append('containerName', containerName);
      params.append('follow', jobInfo.websocket.parameters.follow.toString());
      params.append('tailLines', '500');
      params.append('timestamps', showTimestamps.toString());
    } else if (jobInfo.podName) {
      params.append('podName', jobInfo.podName);
      params.append('namespace', `env-${uuid}`);
      params.append('containerName', containerName);
      params.append('follow', 'false');
      params.append('tailLines', '500');
      params.append('timestamps', showTimestamps.toString());
    }

    const wsUrl = `${wsProtocol}//${host}/api/logs/stream?${params.toString()}`;

    try {
      const newSocket = new WebSocket(wsUrl);

      newSocket.onopen = () => {
        if (isMountedRef.current) {
          setConnectingContainers(prev => prev.filter(c => c !== containerName));
        }
      };

      newSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as LogMessage;

          if (data.type === 'log' && data.payload) {
            if (isMountedRef.current) {
              setLogsByContainer(prev => ({
                ...prev,
                [containerName]: [...(prev[containerName] || []), data.payload]
              }));
            }
          } else if (data.type === 'error' && data.message) {
            console.error(`Log stream error for ${containerName}:`, data.message);
            if (isMountedRef.current) {
              if (data.message !== 'No logs available') {
                setError(`Log stream error for ${containerName}: ${data.message}`);
              }
            }
            setConnectingContainers(prev => prev.filter(c => c !== containerName));
          } else if (data.type === 'end') {
            if (isMountedRef.current) {
              setConnectingContainers(prev => prev.filter(c => c !== containerName));
            }
          }
        } catch (err) {
          console.error(`Error parsing WebSocket message for ${containerName}:`, err);
        }
      };

      newSocket.onerror = (err) => {
        console.error(`WebSocket error for ${containerName}:`, err);
        if (isMountedRef.current) {
          setError(`WebSocket connection error for ${containerName}`);
          setConnectingContainers(prev => prev.filter(c => c !== containerName));
        }
      };

      newSocket.onclose = () => {
        if (isMountedRef.current) {
          setConnectingContainers(prev => prev.filter(c => c !== containerName));
        }
      };

      if (isMountedRef.current) {
        setSocketsByContainer(prev => ({
          ...prev,
          [containerName]: newSocket
        }));
      } else {
        newSocket.close();
      }
    } catch (err) {
      console.error(`Error creating WebSocket for ${containerName}:`, err);
      if (isMountedRef.current) {
        setError(`Failed to create WebSocket for ${containerName}`);
        setConnectingContainers(prev => prev.filter(c => c !== containerName));
      }
    }
  }, [jobInfo, uuid, showTimestamps]);

  useEffect(() => {
    if (activeContainer && activeContainer !== 'events' && jobInfo) {
      connectToContainer(activeContainer);
    }
  }, [activeContainer, jobInfo, connectToContainer]);

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

  const handleTabChange = (containerName: string) => {
    setActiveContainer(containerName);
  };

  const getContainerDisplayName = (containerName: string): string => {
    if (containerName === 'git-clone') return 'Clone Repository';
    if (containerName === 'buildkit' || containerName === 'kaniko') return 'Build';
    if (containerName.includes('[init]')) return containerName;
    return containerName;
  };

  const getStatusColor = (status: BuildJobInfo['status']) => {
    switch (status) {
      case 'Failed':
        return '#dc2626';
      case 'Complete':
        return '#10b981';
      case 'Active':
        return '#3b82f6';
      case 'Pending':
        return '#f59e0b';
      default:
        return '#6b7280';
    }
  };

  const getBackgroundColor = (build: BuildJobInfo, isSelected: boolean) => {
    if (isSelected) {
      switch (build.status) {
        case 'Failed':
          return '#fee2e2';
        case 'Complete':
          return '#d1fae5';
        case 'Pending':
          return '#fef3c7';
        default:
          return '#f3f4f6';
      }
    } else {
      switch (build.status) {
        case 'Failed':
          return '#fef2f2';
        case 'Complete':
          return '#f0fdf4';
        case 'Pending':
          return '#fffbeb';
        default:
          return 'transparent';
      }
    }
  };

  const getHoverColor = (build: BuildJobInfo) => {
    switch (build.status) {
      case 'Failed':
        return '#fee2e2';
      case 'Complete':
        return '#d1fae5';
      case 'Pending':
        return '#fef3c7';
      default:
        return '#f9fafb';
    }
  };

  const getStatusText = (status: BuildJobInfo['status']) => {
    switch (status) {
      case 'Active':
        return 'Building';
      case 'Pending':
        return 'Pending';
      default:
        return status;
    }
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
          <div style={{
            backgroundColor: 'white',
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            display: 'flex',
            flexDirection: 'column',
            height: '100%'
          }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#333', margin: 0 }}>Build History</h2>
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <table style={{ width: '100%', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #eee', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        Status
                      </div>
                    </th>
                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                      SHA
                    </th>
                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                      Started
                    </th>
                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {builds.map((build) => (
                    <tr
                      key={build.jobName}
                      onClick={() => handleJobSelect(build)}
                      style={{
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        backgroundColor: getBackgroundColor(build, selectedJob?.jobName === build.jobName),
                        transition: 'background-color 0.15s'
                      }}
                      onMouseOver={(e) => {
                        if (selectedJob?.jobName !== build.jobName) {
                          e.currentTarget.style.backgroundColor = getHoverColor(build);
                        }
                      }}
                      onMouseOut={(e) => {
                        if (selectedJob?.jobName !== build.jobName) {
                          e.currentTarget.style.backgroundColor = getBackgroundColor(build, false);
                        }
                      }}
                    >
                      <td style={{ padding: '16px 20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            backgroundColor: getStatusColor(build.status),
                            animation: build.status === 'Active' ? 'pulse 2s infinite' : 'none'
                          }} />
                          <span style={{
                            fontSize: '14px',
                            fontWeight: 500,
                            color: getStatusColor(build.status)
                          }}>
                            {getStatusText(build.status)}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '16px 20px' }}>
                        <code style={{ fontSize: '13px', color: '#555' }}>{build.sha}</code>
                      </td>
                      <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                        {formatTimestamp(build.startedAt)}
                      </td>
                      <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                        {formatDuration(build.duration)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

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
