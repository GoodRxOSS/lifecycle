import React from 'react';
import { formatTimestamp } from './utils';

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

interface EventsViewerProps {
  events: K8sEvent[];
  loading: boolean;
  error?: string | null;
}

export const EventsViewer: React.FC<EventsViewerProps> = ({ events, loading, error }) => {
  if (loading) {
    return (
      <div style={{ padding: '20px', color: '#888' }}>
        Loading events...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '20px', color: '#ff6b6b' }}>
        Error loading events: {error}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div style={{ padding: '20px', color: '#888' }}>
        No events available for this job.
      </div>
    );
  }

  return (
    <div style={{ 
      height: '100%',
      overflowY: 'auto',
      padding: '16px',
      backgroundColor: '#1a1a1a'
    }}>
      {events.map((event, index) => {
          const timestamp = event.eventTime || event.lastTimestamp || event.firstTimestamp;
          const isWarning = event.type === 'Warning';
          
          return (
            <div
              key={index}
              style={{
                marginBottom: '16px',
                padding: '12px',
                backgroundColor: '#1a1a1a',
                borderRadius: '6px',
                border: `1px solid ${isWarning ? '#664400' : '#333'}`,
                borderLeft: `4px solid ${isWarning ? '#f59e0b' : '#3b82f6'}`
              }}
            >
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '8px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: isWarning ? '#f59e0b' : '#3b82f6'
                  }}>
                    {event.reason}
                  </span>
                  {event.count > 1 && (
                    <span style={{
                      fontSize: '12px',
                      color: '#888',
                      backgroundColor: '#333',
                      padding: '2px 8px',
                      borderRadius: '12px'
                    }}>
                      ×{event.count}
                    </span>
                  )}
                </div>
                {timestamp && (
                  <span style={{ fontSize: '12px', color: '#888' }}>
                    {formatTimestamp(timestamp)}
                  </span>
                )}
              </div>
              
              <div style={{ 
                fontSize: '13px', 
                color: '#ccc',
                lineHeight: '1.5',
                wordBreak: 'break-word'
              }}>
                {event.message}
              </div>
              
              {event.source?.component && (
                <div style={{ 
                  marginTop: '8px',
                  fontSize: '11px', 
                  color: '#666'
                }}>
                  Source: {event.source.component}
                  {event.source.host && ` on ${event.source.host}`}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
};