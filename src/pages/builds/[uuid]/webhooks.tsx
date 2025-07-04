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
  useJobPolling,
} from '../../../components/logs';

interface WebhookInvocation {
  id: number;
  name: string;
  type: 'codefresh' | 'docker' | 'command';
  state: string;
  status: 'executing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  yamlConfig: string;
  metadata: any;
  buildId: number;
  runUUID: string;
  owner: string;
}

interface WebhookHistoryResponse {
  webhooks: WebhookInvocation[];
}

interface WebhookLogResponse {
  status: 'executing' | 'completed' | 'failed' | 'not_found';
  type: 'codefresh' | 'docker' | 'command';
  metadata: any;
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

export default function WebhookHistory() {
  const router = useRouter();
  const { uuid } = router.query;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookInvocation[]>([]);

  const [selectedWebhook, setSelectedWebhook] = useState<WebhookInvocation | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<WebhookLogResponse | null>(null);
  const [activeContainer, setActiveContainer] = useState<string>('');
  const [loadingWebhook, setLoadingWebhook] = useState(false);

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
    setLogsByContainer,
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

  const fetchWebhooks = async (silent = false) => {
    try {
      const response = await axios.get<WebhookHistoryResponse>(`/api/v1/builds/${uuid}/webhooks?limit=20`);

      setWebhooks(response.data.webhooks);
      setError(null);

      if (!selectedWebhook && response.data.webhooks.length > 0 && !silent) {
        handleWebhookSelect(response.data.webhooks[0]);
      }

      if (selectedWebhook) {
        const updatedWebhook = response.data.webhooks.find((w) => w.id === selectedWebhook.id);
        if (updatedWebhook && updatedWebhook.status !== selectedWebhook.status) {
          setSelectedWebhook(updatedWebhook);
          if (
            selectedWebhook.status === 'executing' &&
            (updatedWebhook.status === 'completed' || updatedWebhook.status === 'failed')
          ) {
            fetchWebhookInfo(updatedWebhook);
          }
        }
      }
    } catch (err: any) {
      if (!silent) {
        console.error('Error fetching webhooks:', err);
        setError(err.response?.data?.error || err.message || 'Failed to fetch webhooks');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const fetchWebhookInfo = async (webhook: WebhookInvocation) => {
    try {
      setLoadingWebhook(true);
      setError(null);
      setActiveContainer('');

      // Create webhook info based on type
      const webhookInfo: WebhookLogResponse = {
        status: webhook.status,
        type: webhook.type,
        metadata: webhook.metadata,
      };

      if (webhook.type === 'codefresh') {
        setActiveContainer('codefresh');
      } else if (webhook.type === 'docker' || webhook.type === 'command') {
        // Get job name from metadata
        const jobName =
          typeof webhook.metadata === 'string' ? JSON.parse(webhook.metadata)?.jobName : webhook.metadata?.jobName;

        if (jobName) {
          try {
            const response = await axios.get(`/api/v1/builds/${uuid}/jobs/${jobName}/logs`);
            webhookInfo.containers = response.data.containers;
            webhookInfo.websocket = response.data.websocket;

            const mainContainer =
              webhookInfo.containers.find((c) => !c.name.includes('init')) || webhookInfo.containers[0];
            setActiveContainer(mainContainer.name);

            fetchWebhookEvents(jobName);
          } catch (err) {
            console.error('Error fetching job logs info:', err);
            // Still set basic info even if logs API fails
            webhookInfo.containers = [{ name: 'webhook-job', state: 'running' }];
            setActiveContainer('webhook-job');
          }
        }
      }

      setWebhookInfo(webhookInfo);
    } catch (err: any) {
      console.error('Error setting webhook info:', err);
      setError(err.message || 'Failed to load webhook information');
    } finally {
      setLoadingWebhook(false);
    }
  };

  const fetchWebhookEvents = async (jobName: string) => {
    try {
      setEventsLoading(true);
      setEventsError(null);

      const response = await axios.get<{ events: K8sEvent[] }>(`/api/v1/builds/${uuid}/jobs/${jobName}/events`);

      setEvents(response.data.events);
    } catch (err: any) {
      console.error('Error fetching webhook events:', err);
      setEventsError(err.response?.data?.error || err.message || 'Failed to fetch events');
    } finally {
      setEventsLoading(false);
    }
  };

  useEffect(() => {
    if (
      activeContainer &&
      activeContainer !== 'events' &&
      activeContainer !== 'config' &&
      activeContainer !== 'metadata' &&
      activeContainer !== 'codefresh' &&
      webhookInfo?.websocket
    ) {
      connectToContainer(activeContainer, webhookInfo);
    }
  }, [activeContainer, webhookInfo, connectToContainer]);

  const handleWebhookSelect = async (webhook: WebhookInvocation) => {
    closeAllConnections();

    setSelectedWebhook(webhook);
    setLogsByContainer({});
    setWebhookInfo(null);
    setActiveContainer('');
    setEvents([]);
    setEventsError(null);

    await fetchWebhookInfo(webhook);
  };

  useJobPolling({
    uuid: uuid as string,
    name: 'webhooks',
    selectedJob: selectedWebhook as any,
    setSelectedJob: (webhook) => setSelectedWebhook(webhook as WebhookInvocation),
    setJobs: (webhooks) => setWebhooks(webhooks as WebhookInvocation[]),
    fetchJobs: fetchWebhooks,
    fetchJobInfo: fetchWebhookInfo as any,
    onJobSelect: handleWebhookSelect as any,
    pollingInterval: 30000,
  });

  const handleTabChange = (containerName: string) => {
    setActiveContainer(containerName);
  };

  const getContainerDisplayName = (containerName: string): string => {
    if (containerName === 'codefresh') return 'Codefresh Link';
    if (containerName === 'config') return 'Configuration';
    if (containerName === 'metadata') return 'Metadata';
    if (containerName.includes('[init]')) return containerName;
    return containerName;
  };

  const getStatusFromWebhookStatus = (status: string): 'Active' | 'Complete' | 'Failed' | 'Pending' => {
    switch (status) {
      case 'completed':
        return 'Complete';
      case 'failed':
        return 'Failed';
      case 'executing':
        return 'Active';
      default:
        return 'Pending';
    }
  };

  const webhooksForTable = webhooks.map((webhook) => ({
    ...webhook,
    status: getStatusFromWebhookStatus(webhook.status),
  }));

  const renderWebhookBadges = (webhook: WebhookInvocation) => (
    <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
      <span
        style={{
          backgroundColor: webhook.type === 'codefresh' ? '#4f46e5' : webhook.type === 'docker' ? '#0ea5e9' : '#8b5cf6',
          color: '#fff',
          padding: '2px 6px',
          borderRadius: '3px',
          fontSize: '10px',
          fontWeight: 500,
        }}
      >
        {webhook.type}
      </span>
      <span
        style={{
          backgroundColor: '#374151',
          color: '#d1d5db',
          padding: '2px 6px',
          borderRadius: '3px',
          fontSize: '10px',
          fontWeight: 500,
        }}
      >
        {webhook.state}
      </span>
    </div>
  );

  const CustomJobHistoryTable = ({ jobs, selectedJob, onJobSelect, title }: any) => (
    <div
      style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #eee',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#333', margin: 0 }}>{title}</h2>
        <div style={{ fontSize: '12px', color: '#666' }}>Latest 20 invocations</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderSpacing: 0 }}>
          <thead>
            <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #eee', position: 'sticky', top: 0 }}>
              <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                Name
              </th>
              <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                Status
              </th>
              <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '14px', fontWeight: 600, color: '#666' }}>
                Execution Time
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((webhook: any) => (
              <tr
                key={webhook.id}
                onClick={() => onJobSelect(webhook)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  backgroundColor: selectedJob?.id === webhook.id ? '#f3f4f6' : 'transparent',
                  transition: 'background-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (selectedJob?.id !== webhook.id) {
                    e.currentTarget.style.backgroundColor = '#f9fafb';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedJob?.id !== webhook.id) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <td style={{ padding: '16px 20px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 500, color: '#333', marginBottom: '4px' }}>
                      {webhook.name}
                    </div>
                    {renderWebhookBadges(webhook)}
                  </div>
                </td>
                <td style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor:
                          webhook.status === 'completed'
                            ? '#10b981'
                            : webhook.status === 'failed'
                            ? '#dc2626'
                            : webhook.status === 'executing'
                            ? '#3b82f6'
                            : '#f59e0b',
                        ...(webhook.status === 'executing' && {
                          animation: 'pulse 2s infinite',
                        }),
                      }}
                    />
                    <span
                      style={{
                        fontSize: '14px',
                        fontWeight: 500,
                        color:
                          webhook.status === 'completed'
                            ? '#10b981'
                            : webhook.status === 'failed'
                            ? '#dc2626'
                            : webhook.status === 'executing'
                            ? '#3b82f6'
                            : '#f59e0b',
                      }}
                    >
                      {webhook.status}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                  {new Date(webhook.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderCodefreshView = () => {
    const link = selectedWebhook?.metadata?.link;
    return (
      <div
        style={{
          padding: '20px',
          color: '#fff',
          fontFamily: 'Monaco, Consolas, monospace',
          fontSize: '14px',
          height: '100%',
          overflow: 'auto',
        }}
      >
        {link ? (
          <div>
            <div style={{ marginBottom: '16px', color: '#666' }}>Codefresh Pipeline Link:</div>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#60a5fa',
                textDecoration: 'underline',
                wordBreak: 'break-all',
              }}
            >
              {link}
            </a>
          </div>
        ) : (
          <div style={{ color: '#666' }}>No link available</div>
        )}
      </div>
    );
  };

  const renderConfigView = () => {
    let config;
    try {
      config = JSON.parse(selectedWebhook?.yamlConfig || '{}');
    } catch {
      config = selectedWebhook?.yamlConfig || '';
    }

    return (
      <div
        style={{
          padding: '20px',
          color: '#fff',
          fontFamily: 'Monaco, Consolas, monospace',
          fontSize: '12px',
          height: '100%',
          overflow: 'auto',
        }}
      >
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {typeof config === 'string' ? config : JSON.stringify(config, null, 2)}
        </pre>
      </div>
    );
  };

  const renderMetadataView = () => {
    return (
      <div
        style={{
          padding: '20px',
          color: '#fff',
          fontFamily: 'Monaco, Consolas, monospace',
          fontSize: '12px',
          height: '100%',
          overflow: 'auto',
        }}
      >
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(selectedWebhook?.metadata || {}, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <>
      <style jsx>{`
        @keyframes pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
      `}</style>
      <PageLayout backLink={`/builds/${uuid}`} title="Webhook History" environmentId={uuid as string}>
        {error && !selectedWebhook && <ErrorAlert error={error} />}

        {loading ? (
          <LoadingBox message="Loading webhooks..." />
        ) : webhooks.length === 0 ? (
          <EmptyState title="No webhooks found" description="Did you forget to invite them to the party?" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '600px 1fr',
              gap: '24px',
              alignItems: 'stretch',
              flex: 1,
              minHeight: 0,
            }}
          >
            <CustomJobHistoryTable
              jobs={webhooks}
              selectedJob={selectedWebhook}
              onJobSelect={handleWebhookSelect}
              title="Webhook History"
            />

            <div
              style={{
                backgroundColor: '#1a1a1a',
                borderRadius: '12px',
                overflow: 'hidden',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: '400px',
              }}
            >
              {selectedWebhook ? (
                <TerminalContainer
                  jobName={selectedWebhook.name}
                  containers={
                    webhookInfo?.type === 'codefresh'
                      ? [
                          { name: 'codefresh', state: 'running' },
                          { name: 'config', state: 'running' },
                          { name: 'metadata', state: 'running' },
                        ]
                      : [
                          ...(webhookInfo?.containers || []),
                          { name: 'config', state: 'running' },
                          { name: 'metadata', state: 'running' },
                        ]
                  }
                  activeContainer={activeContainer}
                  onTabChange={handleTabChange}
                  connectingContainers={connectingContainers}
                  getContainerDisplayName={getContainerDisplayName}
                  showTimestamps={showTimestamps}
                  onTimestampsToggle={() => setShowTimestamps(!showTimestamps)}
                  showEventsTab={webhookInfo?.type !== 'codefresh'}
                >
                  {loadingWebhook ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        color: '#666',
                      }}
                    >
                      <LoadingSpinner size={24} />
                      <span style={{ marginLeft: '12px' }}>Loading webhook details...</span>
                    </div>
                  ) : activeContainer === 'codefresh' ? (
                    renderCodefreshView()
                  ) : activeContainer === 'config' ? (
                    renderConfigView()
                  ) : activeContainer === 'metadata' ? (
                    renderMetadataView()
                  ) : activeContainer === 'events' ? (
                    <EventsViewer events={events} loading={eventsLoading} error={eventsError} />
                  ) : (
                    <LogViewer
                      logs={logsByContainer[activeContainer] || []}
                      isConnecting={connectingContainers.includes(activeContainer)}
                      containerRef={logContainerRef}
                      showTimestamps={showTimestamps}
                      containerState={webhookInfo?.containers?.find((c) => c.name === activeContainer)?.state}
                    />
                  )}
                </TerminalContainer>
              ) : (
                <EmptyTerminalState type="webhook" />
              )}
            </div>
          </div>
        )}
      </PageLayout>
    </>
  );
}
