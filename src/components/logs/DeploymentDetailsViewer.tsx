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

import React from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import * as yaml from 'js-yaml';

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

interface DeploymentDetailsViewerProps {
  details: DeploymentDetails | null;
  loading: boolean;
  error: string | null;
}

const styles = {
  container: {
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#666',
  },
  errorContainer: {
    padding: '24px',
    color: '#ef4444',
    fontFamily: 'monospace',
    fontSize: '13px',
  },
  emptyContainer: {
    padding: '24px',
    color: '#666',
    fontFamily: 'monospace',
    fontSize: '13px',
  },
  flexColumn: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  },
  headerSection: {
    padding: '24px 24px 0 24px',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  infoBox: {
    marginBottom: '24px',
    padding: '16px',
    backgroundColor: '#2d2d2d',
    borderRadius: '8px',
    border: '1px solid #444',
  },
  sectionTitle: {
    margin: '0 0 16px 0',
    color: '#fff',
    fontSize: '16px',
    fontWeight: 600,
  },
  label: {
    color: '#999',
    fontSize: '13px',
  },
  value: {
    color: '#fff',
    fontSize: '13px',
    marginLeft: '8px',
    fontFamily: 'monospace',
  },
  codeBlock: {
    margin: 0,
    padding: '16px',
    backgroundColor: '#2d2d2d',
    borderRadius: '8px',
    border: '1px solid #444',
    color: '#e4e4e7',
    fontSize: '13px',
    fontFamily: 'monospace',
    overflow: 'auto',
    lineHeight: '1.5',
  },
  manifestSection: {
    flex: 1,
    overflow: 'hidden',
    padding: '0 24px 24px 24px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  manifestTitle: {
    margin: '16px 0',
    color: '#fff',
    fontSize: '16px',
    fontWeight: 600,
    flexShrink: 0,
  },
  manifestCode: {
    margin: 0,
    padding: '16px',
    backgroundColor: '#2d2d2d',
    borderRadius: '8px',
    border: '1px solid #444',
    color: '#e4e4e7',
    fontSize: '13px',
    fontFamily: 'monospace',
    overflow: 'auto',
    lineHeight: '1.5',
    flex: 1,
    minHeight: 0,
    boxSizing: 'border-box' as const,
  },
};

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <span style={styles.label}>{label}:</span>
    <span style={styles.value}>{value}</span>
  </div>
);

const CodeSection: React.FC<{ title: string; content: string; style?: React.CSSProperties }> = ({ 
  title, 
  content, 
  style 
}) => (
  <div style={{ 
    display: 'flex', 
    flexDirection: 'column', 
    overflow: 'hidden',
    flex: 1,
    minHeight: 0,
    marginBottom: '16px',
    ...style 
  }}>
    <h3 style={{ ...styles.sectionTitle, flexShrink: 0 }}>{title}</h3>
    <pre style={{ ...styles.codeBlock, flex: 1, minHeight: 0 }}>{content}</pre>
  </div>
);

export function DeploymentDetailsViewer({ details, loading, error }: DeploymentDetailsViewerProps) {
  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <LoadingSpinner size={24} />
        <span style={{ marginLeft: '12px' }}>Loading deployment details...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.errorContainer}>
        Error loading deployment details: {error}
      </div>
    );
  }

  if (!details) {
    return (
      <div style={styles.emptyContainer}>
        No deployment details available
      </div>
    );
  }

  if (details.type === 'helm') {
    return (
      <div style={styles.container}>
        <div style={styles.flexColumn}>
          <div style={{ ...styles.headerSection, flex: details.manifest ? '0 1 50%' : 1 }}>
            <div style={styles.infoBox}>
              <h3 style={styles.sectionTitle}>Release Information</h3>
              <div style={{ display: 'grid', gap: '12px' }}>
                <InfoRow label="Release Name" value={details.releaseName} />
                <InfoRow label="Chart" value={details.chart} />
                {details.version && <InfoRow label="Version" value={details.version} />}
              </div>
            </div>

            <CodeSection 
              title="Values" 
              content={yaml.dump(details.values, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false })} 
            />
          </div>

          {details.manifest && (
            <div style={styles.manifestSection}>
              <h3 style={styles.manifestTitle}>Rendered Manifest</h3>
              <pre style={styles.manifestCode}>{details.manifest}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.flexColumn}>
        <div style={{ ...styles.headerSection, padding: '24px 24px 0 24px' }}>
          <div style={{ ...styles.infoBox, marginBottom: '16px', flexShrink: 0 }}>
            <h3 style={styles.sectionTitle}>GitHub-Type Deployment Information</h3>
            <InfoRow label="ConfigMap" value={details.manifestConfigMap} />
          </div>

          <h3 style={styles.manifestTitle}>Kubernetes Manifest</h3>
        </div>

        <div style={styles.manifestSection}>
          <pre style={styles.manifestCode}>{details.manifest}</pre>
        </div>
      </div>
    </div>
  );
}