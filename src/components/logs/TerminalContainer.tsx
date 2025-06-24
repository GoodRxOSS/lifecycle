import React from 'react';
import { LoadingSpinner } from './LoadingSpinner';

interface Container {
  name: string;
  state: string;
}

interface TerminalContainerProps {
  jobName: string;
  containers?: Container[];
  activeContainer: string;
  // eslint-disable-next-line no-unused-vars
  onTabChange: (_: string) => void;
  connectingContainers: string[];
  // eslint-disable-next-line no-unused-vars
  getContainerDisplayName: (_: string) => string;
  children: React.ReactNode;
  showTimestamps: boolean;
  onTimestampsToggle: () => void;
}

export function TerminalContainer({
  jobName,
  containers,
  activeContainer,
  onTabChange,
  connectingContainers,
  getContainerDisplayName,
  children,
  showTimestamps,
  onTimestampsToggle
}: TerminalContainerProps) {
  return (
    <>
      <div style={{ 
        backgroundColor: '#2d2d2d',
        padding: '12px 16px',
        borderBottom: '1px solid #444',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ fontSize: '13px', color: '#999', fontFamily: 'monospace' }}>
          {jobName}
        </div>
        <label style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px',
          fontSize: '13px',
          color: '#999',
          cursor: 'pointer'
        }}>
          <input
            type="checkbox"
            checked={showTimestamps}
            onChange={onTimestampsToggle}
            style={{
              cursor: 'pointer',
              width: '16px',
              height: '16px'
            }}
          />
          Show timestamps
        </label>
      </div>

      <div style={{ 
        backgroundColor: '#2d2d2d',
        display: 'flex',
        borderBottom: '1px solid #444'
      }}>
        {containers && containers.map((container) => (
          <button
            key={container.name}
            onClick={() => onTabChange(container.name)}
            style={{
              padding: '10px 16px',
              backgroundColor: activeContainer === container.name ? '#1a1a1a' : 'transparent',
              color: activeContainer === container.name ? '#fff' : '#999',
              border: 'none',
              borderBottom: activeContainer === container.name ? '2px solid #3b82f6' : '2px solid transparent',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.15s'
            }}
          >
            {getContainerDisplayName(container.name)}
            {connectingContainers.includes(container.name) && (
              <LoadingSpinner size={12} />
            )}
          </button>
        ))}
        <button
          onClick={() => onTabChange('events')}
          style={{
            padding: '10px 16px',
            backgroundColor: activeContainer === 'events' ? '#1a1a1a' : 'transparent',
            color: activeContainer === 'events' ? '#fff' : '#999',
            border: 'none',
            borderBottom: activeContainer === 'events' ? '2px solid #3b82f6' : '2px solid transparent',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'all 0.15s',
            marginLeft: 'auto'
          }}
        >
          Job Events
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {children}
      </div>
    </>
  );
}

export function EmptyTerminalState({ type }: { type: 'build' | 'deployment' }) {
  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      height: '100%',
      color: '#666',
      flexDirection: 'column',
      padding: '24px',
      textAlign: 'center'
    }}>
      <svg width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <h3 style={{ marginTop: '16px', fontSize: '16px', fontWeight: 600, color: '#fff' }}>
        Select a {type === 'build' ? 'build job' : 'deployment'}
      </h3>
      <p style={{ marginTop: '8px', fontSize: '14px' }}>
        Choose a {type} from the table to view its logs
      </p>
    </div>
  );
} 