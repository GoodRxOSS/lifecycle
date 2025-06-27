import React from 'react';

interface LogLevel {
  pattern: RegExp;
  color: string;
  label: string;
}

const LOG_LEVELS: LogLevel[] = [
  {
    pattern: /\b(ERROR|FATAL|FAIL|FAILED|FAILURE)\b/i,
    color: '#FF5252',
    label: 'ERROR',
  },
  {
    pattern: /\b(WARN|WARNING)\b/i,
    color: '#FFA726',
    label: 'WARN',
  },
  {
    pattern: /\b(INFO|INFORMATION)\b/i,
    color: '#4FC3F7',
    label: 'INFO',
  },
  {
    pattern: /\b(DEBUG|VERBOSE)\b/i,
    color: '#9E9E9E',
    label: 'DEBUG',
  },
];

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

function detectLogLevel(line: string): LogLevel | null {
  for (const level of LOG_LEVELS) {
    if (level.pattern.test(line)) {
      return level;
    }
  }
  return null;
}

export function formatLogLine(line: string, showTimestamps: boolean = true): React.ReactNode | null {
  const logLevel = detectLogLevel(line);
  let processedLine = line;
  
  const timestampMatch = line.match(TIMESTAMP_PATTERN);
  let timestamp = '';
  if (timestampMatch) {
    timestamp = timestampMatch[0];
    processedLine = line.substring(timestamp.length);
    if (processedLine.startsWith(' ')) {
      processedLine = processedLine.substring(1);
    }
  }
  
  if (!processedLine && timestamp) {
    return null;
  }
  
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        padding: '1px 0',
        borderRadius: '4px',
        backgroundColor: 'transparent',
      }}
    >
      {timestamp && showTimestamps && (
        <span
          style={{
            color: '#B39DDB',
            fontWeight: 500,
            marginRight: '12px',
            fontFamily: 'monospace',
            fontSize: '12px',
            minWidth: '180px',
            flexShrink: 0,
          }}
        >
          {timestamp}
        </span>
      )}
      <span
        style={{
          color: logLevel?.color || '#e5e5e5',
          wordBreak: 'break-word',
          flex: 1,
          lineHeight: '1.4',
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
        }}
      >
        {processedLine}
      </span>
    </div>
  );
}

interface LogViewerProps {
  logs: string[];
  isConnecting: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  showTimestamps: boolean;
  containerState?: string;
}

export function LogViewer({ logs, isConnecting, containerRef, showTimestamps, containerState }: LogViewerProps) {
  if (isConnecting) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        color: '#666'
      }}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" style={{ 
          animation: 'spin 1s linear infinite' 
        }}>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25"></circle>
          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" opacity="0.75"></path>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </svg>
        <span style={{ marginLeft: '12px' }}>Connecting to container...</span>
      </div>
    );
  }

  if (logs.length === 0) {
    const getStatusMessage = (state?: string) => {
      if (!state) return 'No logs available for this container';
      
      switch (state.toLowerCase()) {
        case 'waiting':
          return 'Container is waiting to start';
        case 'containercreating':
          return 'Container is being created';
        case 'podinitializing':
          return 'Pod is initializing';
        case 'pullbackoff':
        case 'imagepullbackoff':
          return 'Failed to pull container image';
        case 'crashloopbackoff':
          return 'Container is crash looping';
        case 'errimagepull':
          return 'Error pulling container image';
        case 'createcontainererror':
          return 'Error creating container';
        case 'terminated':
          return 'Container has terminated';
        case 'completed':
          return 'Container has completed';
        case 'running':
          return 'Container is running (logs may appear soon)';
        default:
          return `Container status: ${state}`;
      }
    };

    const getStatusColor = (state?: string) => {
      if (!state) return '#666';
      
      const lowerState = state.toLowerCase();
      if (lowerState.includes('error') || lowerState.includes('crash') || lowerState.includes('fail')) {
        return '#FF5252';
      }
      if (lowerState.includes('creating') || lowerState.includes('waiting') || lowerState.includes('initializing')) {
        return '#FFA726';
      }
      if (lowerState === 'running') {
        return '#4CAF50';
      }
      return '#666';
    };

    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        color: getStatusColor(containerState),
        flexDirection: 'column',
        padding: '20px',
        textAlign: 'center'
      }}>
        <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p style={{ marginTop: '12px', fontWeight: 600 }}>{getStatusMessage(containerState)}</p>
        {containerState && (
          <p style={{ marginTop: '8px', fontSize: '12px', color: '#999' }}>
            Current state: <span style={{ fontFamily: 'monospace', color: getStatusColor(containerState) }}>{containerState}</span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '16px',
        paddingBottom: '60px',
        fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace",
        fontSize: '13px',
        lineHeight: '1.5',
        color: '#e5e5e5',
        boxSizing: 'border-box'
      }}
    >
      {logs.map((log, index) => {
        const formatted = formatLogLine(log, showTimestamps);
        if (!formatted) return null;
        
        return <React.Fragment key={index}>{formatted}</React.Fragment>;
      })}
    </div>
  );
} 