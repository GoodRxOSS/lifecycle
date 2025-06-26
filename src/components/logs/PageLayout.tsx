import React from 'react';
import Link from 'next/link';

interface PageLayoutProps {
  backLink: string;
  title: string;
  serviceName?: string;
  environmentId?: string;
  deploymentType?: 'helm' | 'github';
  children: React.ReactNode;
}

export function PageLayout({ backLink, title, serviceName, environmentId, deploymentType, children }: PageLayoutProps) {
  return (
    <div style={{ 
      height: '100vh',
      overflow: 'hidden',
      backgroundColor: '#f5f5f5',
      fontFamily: "'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
    }}>
      <div style={{ 
        padding: '32px', 
        maxWidth: '100%', 
        margin: '0',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box'
      }}>
        <div style={{ marginBottom: '24px', flexShrink: 0 }}>
          <Link 
            href={backLink}
            style={{ 
              display: 'inline-flex', 
              alignItems: 'center', 
              color: '#666', 
              textDecoration: 'none',
              fontSize: '14px',
              marginBottom: '16px'
            }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ marginRight: '6px' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Environment
          </Link>
          <h1 style={{ 
            fontSize: '28px', 
            fontWeight: 700, 
            color: '#333',
            margin: 0,
            letterSpacing: '-0.02em'
          }}>
            {title}
          </h1>
          {serviceName && environmentId && (
            <div style={{ marginTop: '8px', color: '#666', fontSize: '14px' }}>
              <span style={{ fontWeight: 500 }}>Service:</span> {serviceName} &nbsp;&nbsp;•&nbsp;&nbsp;
              <span style={{ fontWeight: 500 }}>Environment:</span> <code style={{ fontSize: '13px', color: '#555' }}>{environmentId}</code>
              {deploymentType && (
                <>
                  &nbsp;&nbsp;•&nbsp;&nbsp;
                  <span style={{ fontWeight: 500 }}>Type:</span>{' '}
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '12px',
                    fontWeight: 500,
                    backgroundColor: deploymentType === 'helm' ? '#dbeafe' : '#e0e7ff',
                    color: deploymentType === 'helm' ? '#1e40af' : '#4338ca',
                    textTransform: 'uppercase'
                  }}>
                    {deploymentType}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        
        {children}

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}</style>
      </div>
    </div>
  );
}

interface ErrorAlertProps {
  error: string;
}

export function ErrorAlert({ error }: ErrorAlertProps) {
  return (
    <div style={{
      backgroundColor: '#fee',
      border: '1px solid #fcc',
      borderRadius: '8px',
      padding: '16px',
      marginBottom: '24px',
      display: 'flex',
      alignItems: 'flex-start',
      flexShrink: 0
    }}>
      <svg width="20" height="20" fill="#dc2626" viewBox="0 0 20 20" style={{ marginRight: '12px', flexShrink: 0 }}>
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
      </svg>
      <div>
        <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: '4px' }}>Error</div>
        <div style={{ color: '#7f1d1d', fontSize: '14px' }}>{error}</div>
      </div>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div style={{ 
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '48px',
      textAlign: 'center',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      flex: 1
    }}>
      <svg width="32" height="32" fill="none" stroke="#ccc" viewBox="0 0 24 24" style={{ margin: '0 auto' }}>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#333', marginTop: '16px', marginBottom: '8px' }}>
        {title}
      </h3>
      <p style={{ color: '#666', fontSize: '14px' }}>{description}</p>
    </div>
  );
} 