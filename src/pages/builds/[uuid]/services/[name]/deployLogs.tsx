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
  EventsViewer,
  DeploymentDetailsViewer
} from '../../../../../components/logs';

interface DeploymentJobInfo {
  jobName: string;
  deployUuid: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  error?: string;
  podName?: string;
  deploymentType?: 'helm' | 'github';
}

interface DeployLogsListResponse {
  deployments: DeploymentJobInfo[];
}

interface DeployLogStreamResponse {
  status: 'Active' | 'Complete' | 'Failed' | 'NotFound' | 'Pending';
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

interface HelmDeploymentDetails {
  type: 'helm';
  releaseName: string;
  chart: string;
  version?: string;
  values: Record<string, any>;
  manifest?: string;
}

interface GitHubDeploymentDetails {
  type: 'github';
  manifestConfigMap: string;
  manifest: string;
}

type DeploymentDetails = HelmDeploymentDetails | GitHubDeploymentDetails;

export default function DeployLogsList() {
  const router = useRouter();
  const { uuid, name } = router.query;
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<DeploymentJobInfo[]>([]);
  
  const [selectedJob, setSelectedJob] = useState<DeploymentJobInfo | null>(null);
  const [jobInfo, setJobInfo] = useState<DeployLogStreamResponse | null>(null);
  const [activeContainer, setActiveContainer] = useState<string>('');
  const [logsByContainer, setLogsByContainer] = useState<Record<string, string[]>>({});
  const [, setSocketsByContainer] = useState<Record<string, WebSocket | null>>({});
  const [connectingContainers, setConnectingContainers] = useState<string[]>([]);
  const [loadingJob, setLoadingJob] = useState(false);
  
  const [showTimestamps, setShowTimestamps] = useState(true);
  
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  
  const [deploymentDetails, setDeploymentDetails] = useState<DeploymentDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  
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
      fetchDeployments();
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
      fetchDeployments(true); // silent fetch - no loading state
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

  const fetchDeployments = async (silent = false) => {
    try {
      const response = await axios.get<DeployLogsListResponse>(
        `/api/v1/builds/${uuid}/services/${name}/deployLogs`
      );
      
      setDeployments(response.data.deployments);
      setError(null);
      
      if (!selectedJob && response.data.deployments.length > 0 && !silent) {
        handleJobSelect(response.data.deployments[0]);
      }
      
      if (selectedJob) {
        const updatedJob = response.data.deployments.find(d => d.jobName === selectedJob.jobName);
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
        console.error('Error fetching deployments:', err);
        setError(err.response?.data?.error || err.message || 'Failed to fetch deployments');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const fetchJobInfo = async (job: DeploymentJobInfo) => {
    try {
      setLoadingJob(true);
      setError(null);
      setActiveContainer('');
      
      const response = await axios.get<DeployLogStreamResponse>(
        `/api/v1/builds/${uuid}/services/${name}/deployLogs/${job.jobName}`
      );

      setJobInfo(response.data);
      
      if (response.data.status !== 'NotFound' && response.data.status !== job.status) {
        if (response.data.status === 'Active' || response.data.status === 'Complete' || 
            response.data.status === 'Failed' || response.data.status === 'Pending') {
          const validStatus = response.data.status as DeploymentJobInfo['status'];
          setSelectedJob(prev => prev ? { ...prev, status: validStatus } : prev);
          setDeployments(prev => prev.map(d => 
            d.jobName === job.jobName ? { ...d, status: validStatus } : d
          ));
        }
      }

      if (response.data.status === 'NotFound') {
        setError(response.data.error || 'Job not found');
        return;
      }
      
      fetchJobEvents(job.jobName);
      
      if (response.data.containers && response.data.containers.length > 0) {
        const mainContainer = response.data.containers.find(c => c.name === 'helm-deploy') ||
                            response.data.containers.find(c => !c.name.includes('init')) ||
                            response.data.containers[0];
        setActiveContainer(mainContainer.name);
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

  const fetchDeploymentDetails = async () => {
    try {
      setDetailsLoading(true);
      setDetailsError(null);
      setDeploymentDetails(null);
      
      const response = await axios.get<DeploymentDetails>(
        `/api/v1/builds/${uuid}/services/${name}/deployment`
      );
      
      setDeploymentDetails(response.data);
    } catch (err: any) {
      console.error('Error fetching deployment details:', err);
      const errorMessage = err.response?.data?.error || err.message || 'Failed to fetch deployment details';
      setDetailsError(errorMessage);
      
      if (err.response?.status !== 404) {
        console.error('Unexpected error fetching deployment details:', err);
      }
    } finally {
      setDetailsLoading(false);
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
    if (!jobInfo?.websocket || !isMountedRef.current) return;

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
    params.append('podName', jobInfo.websocket.parameters.podName);
    params.append('namespace', jobInfo.websocket.parameters.namespace);
    params.append('containerName', containerName);
    params.append('follow', jobInfo.websocket.parameters.follow.toString());
    params.append('tailLines', '500');
    params.append('timestamps', showTimestamps.toString());

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
  }, [jobInfo, showTimestamps]);

  useEffect(() => {
    if (activeContainer && activeContainer !== 'events' && activeContainer !== 'details' && jobInfo?.websocket) {
      connectToContainer(activeContainer);
    }
  }, [activeContainer, jobInfo, connectToContainer]);

  const handleJobSelect = async (job: DeploymentJobInfo) => {
    closeAllConnections();
    
    setSelectedJob(job);
    setLogsByContainer({});
    setJobInfo(null);
    setActiveContainer('');
    setEvents([]);
    setEventsError(null);
    setDeploymentDetails(null);
    setDetailsError(null);
    
    await Promise.all([
      fetchJobInfo(job),
      fetchDeploymentDetails()
    ]);
  };

  const handleTabChange = (containerName: string) => {
    setActiveContainer(containerName);
  };

  const getContainerDisplayName = (containerName: string): string => {
    if (containerName === 'clone-repo') return 'Clone Repository';
    if (containerName === 'helm-deploy') return 'Helm Deploy';
    if (containerName.includes('[init]')) return containerName;
    return containerName;
  };

  const getStatusColor = (status: DeploymentJobInfo['status']) => {
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

  const getBackgroundColor = (deployment: DeploymentJobInfo, isSelected: boolean) => {
    if (isSelected) {
      switch (deployment.status) {
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
      switch (deployment.status) {
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

  const getHoverColor = (deployment: DeploymentJobInfo) => {
    switch (deployment.status) {
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

  const getStatusText = (status: DeploymentJobInfo['status']) => {
    switch (status) {
      case 'Active':
        return 'Deploying';
      case 'Pending':
        return 'Pending';
      default:
        return status;
    }
  };

  return (
    <PageLayout
      backLink={`/builds/${uuid}`}
      title="Deploy Logs"
      serviceName={name as string}
      environmentId={uuid as string}
      deploymentType={selectedJob?.deploymentType}
    >
      {error && !selectedJob && <ErrorAlert error={error} />}

      {loading ? (
        <LoadingBox message="Loading deployments..." />
      ) : deployments.length === 0 ? (
        <EmptyState
          title="No deployments found"
          description="No deployment jobs have been created for this service yet."
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
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#333', margin: 0 }}>Deployment History</h2>
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
                  {deployments.map((deployment) => (
                    <tr 
                      key={deployment.jobName}
                      onClick={() => handleJobSelect(deployment)}
                      style={{ 
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        backgroundColor: getBackgroundColor(deployment, selectedJob?.jobName === deployment.jobName),
                        transition: 'background-color 0.15s'
                      }}
                      onMouseOver={(e) => {
                        if (selectedJob?.jobName !== deployment.jobName) {
                          e.currentTarget.style.backgroundColor = getHoverColor(deployment);
                        }
                      }}
                      onMouseOut={(e) => {
                        if (selectedJob?.jobName !== deployment.jobName) {
                          e.currentTarget.style.backgroundColor = getBackgroundColor(deployment, false);
                        }
                      }}
                    >
                      <td style={{ padding: '16px 20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            backgroundColor: getStatusColor(deployment.status),
                            animation: deployment.status === 'Active' ? 'pulse 2s infinite' : 'none'
                          }} />
                          <span style={{ 
                            fontSize: '14px', 
                            fontWeight: 500,
                            color: getStatusColor(deployment.status)
                          }}>
                            {getStatusText(deployment.status)}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '16px 20px' }}>
                        <code style={{ fontSize: '13px', color: '#555' }}>{deployment.sha}</code>
                      </td>
                      <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                        {formatTimestamp(deployment.startedAt)}
                      </td>
                      <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                        {formatDuration(deployment.duration)}
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
                showDetailsTab={true}
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
                ) : activeContainer === 'details' ? (
                  <DeploymentDetailsViewer
                    details={deploymentDetails}
                    loading={detailsLoading}
                    error={detailsError}
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
              <EmptyTerminalState type="deployment" />
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
} 