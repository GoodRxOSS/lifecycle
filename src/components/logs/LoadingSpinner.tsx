import React from 'react';

interface LoadingSpinnerProps {
  size?: number;
  color?: string;
}

export function LoadingSpinner({ size = 24, color = 'currentColor' }: LoadingSpinnerProps) {
  return (
    <svg 
      width={size} 
      height={size} 
      fill="none" 
      viewBox="0 0 24 24" 
      style={{ 
        animation: 'spin 1s linear infinite',
      }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="4" opacity="0.25"></circle>
      <path fill={color} d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" opacity="0.75"></path>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </svg>
  );
}

export function LoadingBox({ message }: { message: string }) {
  return (
    <div style={{ 
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '48px',
      textAlign: 'center',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      flex: 1
    }}>
      <LoadingSpinner size={32} color="#ccc" />
      <p style={{ marginTop: '16px', color: '#666' }}>{message}</p>
    </div>
  );
} 