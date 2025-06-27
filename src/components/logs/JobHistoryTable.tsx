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
import { formatTimestamp, formatDuration } from './utils';

interface JobInfo {
  jobName: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  startedAt?: string;
  duration?: number;
}

interface JobHistoryTableProps<T extends JobInfo> {
  jobs: T[];
  selectedJob: T | null;
  // eslint-disable-next-line no-unused-vars
  onJobSelect: (job: T) => void;
  title: string;
  statusTextMap?: {
    Active?: string;
    Pending?: string;
  };
}

const getStatusColor = (status: JobInfo['status']) => {
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

export function JobHistoryTable<T extends JobInfo>({
  jobs,
  selectedJob,
  onJobSelect,
  title,
  statusTextMap = {}
}: JobHistoryTableProps<T>) {
  const getStatusText = (status: JobInfo['status']) => {
    if (status === 'Active' && statusTextMap.Active) {
      return statusTextMap.Active;
    }
    if (status === 'Pending' && statusTextMap.Pending) {
      return statusTextMap.Pending;
    }
    return status;
  };

  return (
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
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#333', margin: 0 }}>{title}</h2>
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
            {jobs.map((job) => (
              <tr
                key={job.jobName}
                onClick={() => onJobSelect(job)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  backgroundColor: selectedJob?.jobName === job.jobName ? '#f3f4f6' : 'transparent',
                  transition: 'background-color 0.15s'
                }}
                onMouseEnter={(e) => {
                  if (selectedJob?.jobName !== job.jobName) {
                    e.currentTarget.style.backgroundColor = '#f9fafb';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedJob?.jobName !== job.jobName) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <td style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: getStatusColor(job.status),
                      animation: job.status === 'Active' ? 'pulse 2s infinite' : 'none'
                    }} />
                    <span style={{
                      fontSize: '14px',
                      fontWeight: 500,
                      color: getStatusColor(job.status)
                    }}>
                      {getStatusText(job.status)}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '16px 20px' }}>
                  <code style={{ fontSize: '13px', color: '#555' }}>{job.sha}</code>
                </td>
                <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                  {formatTimestamp(job.startedAt)}
                </td>
                <td style={{ padding: '16px 20px', fontSize: '14px', color: '#666' }}>
                  {formatDuration(job.duration)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}