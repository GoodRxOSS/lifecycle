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
  DeploymentDetailsViewer,
  JobHistoryTable,
  useWebSocketLogs,
  useJobPolling
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

  useEffect(() => {
    if (activeContainer && activeContainer !== 'events' && activeContainer !== 'details' && jobInfo?.websocket) {
      connectToContainer(activeContainer, jobInfo);
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

  useJobPolling({
    uuid: uuid as string,
    name: name as string,
    selectedJob,
    setSelectedJob: (job) => setSelectedJob(job),
    setJobs: (jobs) => setDeployments(jobs),
    fetchJobs: fetchDeployments,
    fetchJobInfo,
    onJobSelect: handleJobSelect
  });

  const handleTabChange = (containerName: string) => {
    setActiveContainer(containerName);
  };

  const getContainerDisplayName = (containerName: string): string => {
    if (containerName === 'clone-repo') return 'Clone Repository';
    if (containerName === 'helm-deploy') return 'Helm Deploy';
    if (containerName.includes('[init]')) return containerName;
    return containerName;
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
          <JobHistoryTable
            jobs={deployments}
            selectedJob={selectedJob}
            onJobSelect={handleJobSelect}
            title="Deployment History"
            statusTextMap={{ Active: 'Deploying' }}
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
                    containerState={jobInfo?.containers?.find(c => c.name === activeContainer)?.state}
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