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

(function () {
  const SERVICE_NAME = window.LFC_SERVICE_NAME || 'service name';
  const UUID = window.LFC_UUID || 'not found';

  const BADGE_STYLES = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    backgroundColor: 'rgba(33, 33, 33, 0.95)',
    color: '#fff',
    borderRadius: '8px',
    fontSize: '18px',
    zIndex: '2147483647',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    transition: 'all 0.2s ease',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    userSelect: 'text',
    overflow: 'hidden',
    pointerEvents: 'auto',
  };

  const TERMINAL_COLORS = {
    bg: '#1E1E1E',
    text: '#D4D4D4',
    error: '#FF5252',
    warning: '#FFA726',
    info: '#4CAF50',
    prompt: '#64B5F6',
  };

  const LINK_STYLES = 'color: #4CAF50; text-decoration: none; border-bottom: 1px dotted #4CAF50;';
  const BADGE_ID = 'versionBadge';
  const LOG_MODAL_ID = 'logsModal';
  const LOG_MODAL_CONTENT_ID = 'logsModalContent';
  const LOG_BUTTON_ID = 'showLogsButton';
  const SEARCH_INPUT_ID = 'logSearchInput';

  let shadowRoot = null;
  let logsModal = null;
  let evtSource = null;
  const state = {
    isHidden: true,
    terminalWasOpen: false,
    shouldShowBadge: false,
    isCollapsed: false,
    badgePosition: {
      x: null,
      y: null,
    },
  };

  function createShadowHost() {
    const host = document.createElement('div');
    host.id = 'lifecycle-banner-host';
    host.style.cssText = `
      position: fixed !important;
      z-index: 2147483647 !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      pointer-events: none !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    `;
    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;
    shadowRoot.appendChild(style);

    return shadowRoot;
  }

  function formatTimeRemaining(createdAt, ttlDays = 7) {
    if (!createdAt) return null;

    const created = new Date(createdAt);
    const expiresAt = new Date(created.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const remaining = expiresAt - now;

    if (remaining <= 0) return 'Expired';

    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    if (days > 0) return `${days}d ${hours}h`;

    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    if (hours > 0) return `${hours}h ${minutes}m`;

    return `${minutes}m`;
  }

  function getStatusColor(status) {
    const statusLower = (status || '').toLowerCase();
    if (statusLower === 'running' || statusLower === 'success') return '#4CAF50';
    if (
      statusLower === 'deploying' ||
      statusLower === 'building' ||
      statusLower === 'pending' ||
      statusLower === 'queued'
    )
      return '#FFA726';
    if (statusLower === 'failed' || statusLower === 'error') return '#FF5252';
    return '#888';
  }

  function loadState() {
    const hiddenState = localStorage.getItem('componentsHidden');
    const badgeVisibleState = localStorage.getItem('badgeVisible');

    state.isHidden = hiddenState === null ? true : hiddenState === 'true';
    state.shouldShowBadge = badgeVisibleState === null ? false : badgeVisibleState === 'true';
    state.terminalWasOpen = localStorage.getItem('terminalWasOpen') === 'true';
    state.isCollapsed = localStorage.getItem('bannerCollapsed') === 'true';

    const savedPosition = localStorage.getItem('badgePosition');
    if (savedPosition) {
      try {
        const parsedPosition = JSON.parse(savedPosition);
        if (typeof parsedPosition.x === 'number' && typeof parsedPosition.y === 'number') {
          state.badgePosition = parsedPosition;
        }
      } catch (e) {
        console.error('Error parsing badge position:', e);
      }
    }
  }

  function restoreComponents() {
    state.isHidden = false;
    state.shouldShowBadge = true;
    toggleBadge();
    saveState();

    if (state.terminalWasOpen) {
      if (!logsModal) logsModal = createLogsModal();
      showLogsModal();
    }
  }

  function toggleBadge(forceHide = false) {
    let badge = shadowRoot.getElementById(BADGE_ID);

    if (forceHide) {
      if (badge) badge.style.display = 'none';
      return;
    }

    const content = buildBadgeContent();
    if (!content) return;

    if (badge) {
      badge.style.display = state.isCollapsed ? 'flex' : 'block';
      return;
    }

    badge = createBadge(content);
    addShowLogsButton(badge);
    shadowRoot.appendChild(badge);
    saveState();
  }

  function saveState() {
    localStorage.setItem('componentsHidden', state.isHidden);
    localStorage.setItem('terminalWasOpen', state.terminalWasOpen);
    localStorage.setItem('badgeVisible', state.shouldShowBadge);
    localStorage.setItem('badgePosition', JSON.stringify(state.badgePosition));
    localStorage.setItem('bannerCollapsed', state.isCollapsed);
  }

  function buildBadgeContent() {
    const status = window.LFC_DEPLOY_STATUS || '';
    const statusColor = getStatusColor(status);
    const statusLower = (status || '').toLowerCase();
    const isPulsing =
      statusLower === 'deploying' ||
      statusLower === 'building' ||
      statusLower === 'pending' ||
      statusLower === 'queued';

    const statusIndicator = status
      ? `
      <div style="display: flex; align-items: center; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <span style="width: 10px; height: 10px; border-radius: 50%; background-color: ${statusColor}; margin-right: 8px; ${
          isPulsing ? 'animation: pulse 1.5s infinite;' : ''
        }"></span>
        <span style="font-size: 14px; color: ${statusColor}; text-transform: capitalize;">${status}</span>
      </div>
    `
      : '';

    const ttlRemaining = formatTimeRemaining(window.LFC_CREATED_AT);
    const ttlDisplay = ttlRemaining
      ? `
      <div style="margin: 4px 0; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 14px; color: #888;">Expires in:</span>
        <span style="font-size: 14px; color: ${
          ttlRemaining === 'Expired' ? '#FF5252' : '#FFA726'
        };">${ttlRemaining}</span>
      </div>
    `
      : '';

    if (!window.LFC_BANNER || !window.LFC_BANNER.length) return statusIndicator + ttlDisplay + 'Test Content';

    const bannerContent = window.LFC_BANNER.filter((item) => item.value)
      .map((item) => {
        const label = item.label;
        const value = item.url
          ? `<a href='${item.url}' target='_blank' style='${LINK_STYLES}'>${item.value}</a>`
          : item.value;
        return `<div style="margin: 4px 0;">
                  <span style="font-size: 14px; color: #888;">${label}:</span>
                  <div style="font-size: 16px; margin-top: 2px;">${value}</div>
                </div>`;
      })
      .join('');

    return statusIndicator + ttlDisplay + bannerContent;
  }

  function makeDraggable(badge) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    const dragHandle = document.createElement('div');
    dragHandle.id = 'drag-handle';
    dragHandle.style.cssText = `
      width: 100%;
      height: 25px;
      background-color: rgba(255, 255, 255, 0.1);
      cursor: move;
      position: relative;
      margin-bottom: 8px;
    `;

    const dragIndicator = document.createElement('div');
    dragIndicator.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 30px;
      height: 4px;
      background-color: rgba(255, 255, 255, 0.3);
      border-radius: 2px;
    `;
    dragHandle.appendChild(dragIndicator);
    badge.insertBefore(dragHandle, badge.firstChild);

    function handleMouseDown(e) {
      const collapseBtn = badge.querySelector('#collapse-btn');
      if (e.target !== dragHandle && e.target !== dragIndicator && e.target !== collapseBtn) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = badge.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      badge.style.transition = 'none';
      dragHandle.style.cursor = 'grabbing';
    }

    function handleMouseMove(e) {
      if (!isDragging) return;
      e.preventDefault();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = initialX + dx;
      const newY = initialY + dy;
      const maxX = window.innerWidth - badge.offsetWidth;
      const maxY = window.innerHeight - badge.offsetHeight;

      badge.style.right = 'auto';
      badge.style.bottom = 'auto';
      badge.style.left = `${Math.min(Math.max(0, newX), maxX)}px`;
      badge.style.top = `${Math.min(Math.max(0, newY), maxY)}px`;
    }

    function handleMouseUp() {
      if (!isDragging) return;

      isDragging = false;
      dragHandle.style.cursor = 'move';
      badge.style.transition = 'all 0.2s ease';

      const rect = badge.getBoundingClientRect();
      state.badgePosition = { x: rect.left, y: rect.top };
      saveState();
    }

    badge.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  function addCollapseButton(badge, contentWrapper) {
    const collapseBtn = document.createElement('button');
    collapseBtn.id = 'collapse-btn';
    collapseBtn.innerHTML = state.isCollapsed ? '&#9889;' : '&minus;';
    Object.assign(collapseBtn.style, {
      position: 'absolute',
      top: '5px',
      right: '5px',
      width: '20px',
      height: '20px',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      border: 'none',
      borderRadius: '4px',
      color: '#fff',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      padding: '0',
      zIndex: '10',
    });

    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.isCollapsed = !state.isCollapsed;
      updateBadgeCollapsedState(badge, contentWrapper);
      saveState();
    });

    badge.appendChild(collapseBtn);
  }

  function updateBadgeCollapsedState(badge, contentWrapper) {
    const collapseBtn = badge.querySelector('#collapse-btn');
    const buttonContainer = shadowRoot.getElementById(`${LOG_BUTTON_ID}-container`);
    const dragHandle = badge.querySelector('#drag-handle');

    if (state.isCollapsed) {
      contentWrapper.style.display = 'none';
      if (buttonContainer) buttonContainer.style.display = 'none';
      if (dragHandle) dragHandle.style.display = 'none';
      badge.style.width = '50px';
      badge.style.height = '50px';
      badge.style.borderRadius = '50%';
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.justifyContent = 'center';
      badge.style.padding = '0';
      collapseBtn.innerHTML = '&#9889;';
      collapseBtn.style.position = 'static';
      collapseBtn.style.width = '100%';
      collapseBtn.style.height = '100%';
      collapseBtn.style.fontSize = '24px';
      collapseBtn.style.backgroundColor = 'transparent';
      collapseBtn.style.borderRadius = '50%';
    } else {
      contentWrapper.style.display = 'block';
      if (buttonContainer && !state.terminalWasOpen) buttonContainer.style.display = 'block';
      if (dragHandle) dragHandle.style.display = 'block';
      badge.style.width = '';
      badge.style.height = '';
      badge.style.borderRadius = '8px';
      badge.style.display = 'block';
      badge.style.alignItems = '';
      badge.style.justifyContent = '';
      badge.style.padding = '';
      collapseBtn.innerHTML = '&minus;';
      collapseBtn.style.position = 'absolute';
      collapseBtn.style.width = '20px';
      collapseBtn.style.height = '20px';
      collapseBtn.style.fontSize = '16px';
      collapseBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
      collapseBtn.style.borderRadius = '4px';
    }
  }

  function createBadge(content) {
    const badge = document.createElement('div');
    badge.id = BADGE_ID;
    Object.assign(badge.style, BADGE_STYLES);

    const contentWrapper = document.createElement('div');
    contentWrapper.id = 'badge-content-wrapper';
    contentWrapper.style.padding = '0 15px';
    contentWrapper.innerHTML = content;
    badge.appendChild(contentWrapper);

    if (state.badgePosition.x !== null && state.badgePosition.y !== null) {
      badge.style.right = 'auto';
      badge.style.bottom = 'auto';
      badge.style.left = `${state.badgePosition.x}px`;
      badge.style.top = `${state.badgePosition.y}px`;
    }

    addCollapseButton(badge, contentWrapper);

    if (state.isCollapsed) {
      updateBadgeCollapsedState(badge, contentWrapper);
    }

    makeDraggable(badge);
    return badge;
  }

  function addShowLogsButton(badge) {
    const buttonContainer = document.createElement('div');
    buttonContainer.id = `${LOG_BUTTON_ID}-container`;
    Object.assign(buttonContainer.style, {
      padding: '8px 15px 15px 15px',
      borderTop: '1px solid rgba(255, 255, 255, 0.1)',
      marginTop: '10px',
      display: state.terminalWasOpen || state.isCollapsed ? 'none' : 'block',
    });

    const btn = document.createElement('button');
    btn.id = LOG_BUTTON_ID;
    btn.textContent = 'Show logs';
    Object.assign(btn.style, {
      padding: '8px 12px',
      fontSize: '14px',
      cursor: 'pointer',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      color: '#fff',
      borderRadius: '4px',
      width: '100%',
      transition: 'all 0.2s ease',
    });

    btn.addEventListener('mouseover', () => (btn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'));
    btn.addEventListener('mouseout', () => (btn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showLogsModal();
      buttonContainer.style.display = 'none';
    });

    buttonContainer.appendChild(btn);
    badge.appendChild(buttonContainer);
  }

  function createLogsModal() {
    const modal = document.createElement('div');
    modal.id = LOG_MODAL_ID;
    Object.assign(modal.style, {
      position: 'fixed',
      left: '0',
      right: '0',
      bottom: '0',
      height: '400px',
      backgroundColor: TERMINAL_COLORS.bg,
      borderTop: `2px solid ${TERMINAL_COLORS.prompt}`,
      zIndex: '2147483647',
      overflow: 'hidden',
      display: 'none',
      fontFamily: '"Fira Code", "Source Code Pro", monospace',
      pointerEvents: 'auto',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      height: '40px',
      backgroundColor: '#2D2D2D',
      borderBottom: '1px solid #3D3D3D',
      display: 'flex',
      alignItems: 'center',
      padding: '0 10px',
      cursor: 'ns-resize',
      position: 'relative',
    });

    const controls = document.createElement('div');
    controls.innerHTML = `
      <span style="height: 12px; width: 12px; background-color: #FF5F56; border-radius: 50%; display: inline-block; margin-right: 6px;"></span>
      <span style="height: 12px; width: 12px; background-color: #FFBD2E; border-radius: 50%; display: inline-block; margin-right: 6px;"></span>
      <span style="height: 12px; width: 12px; background-color: #27C93F; border-radius: 50%; display: inline-block;"></span>
    `;
    header.appendChild(controls);

    const searchContainer = document.createElement('div');
    Object.assign(searchContainer.style, {
      position: 'absolute',
      right: '40px',
      top: '50%',
      transform: 'translateY(-50%)',
      display: 'flex',
      alignItems: 'center',
      zIndex: '1',
    });

    const searchInput = document.createElement('input');
    searchInput.id = SEARCH_INPUT_ID;
    Object.assign(searchInput.style, {
      backgroundColor: '#3D3D3D',
      border: 'none',
      color: TERMINAL_COLORS.text,
      padding: '5px 10px',
      borderRadius: '4px',
      width: '200px',
      fontSize: '14px',
      height: '28px',
    });
    searchInput.placeholder = 'Filter logs...';
    searchContainer.appendChild(searchInput);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, {
      backgroundColor: '#3D3D3D',
      border: 'none',
      color: TERMINAL_COLORS.text,
      padding: '5px 10px',
      borderRadius: '4px',
      marginLeft: '8px',
      cursor: 'pointer',
      fontSize: '14px',
      height: '28px',
    });

    copyBtn.addEventListener('click', async () => {
      const contentDiv = shadowRoot.getElementById(LOG_MODAL_CONTENT_ID);
      const logLines = Array.from(contentDiv.getElementsByClassName('log-line'))
        .filter((line) => line.style.display !== 'none')
        .map((line) => line.textContent)
        .join('\n');

      try {
        await navigator.clipboard.writeText(logLines);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 2000);
      } catch (err) {
        console.error('Failed to copy logs:', err);
        copyBtn.textContent = 'Failed';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 2000);
      }
    });

    copyBtn.addEventListener('mouseover', () => (copyBtn.style.backgroundColor = '#4D4D4D'));
    copyBtn.addEventListener('mouseout', () => (copyBtn.style.backgroundColor = '#3D3D3D'));

    searchContainer.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      right: '10px',
      top: '50%',
      transform: 'translateY(-50%)',
      backgroundColor: 'transparent',
      border: 'none',
      color: TERMINAL_COLORS.text,
      fontSize: '20px',
      cursor: 'pointer',
      padding: '5px',
      lineHeight: '1',
      zIndex: '1',
    });
    closeBtn.addEventListener('click', hideLogsModal);

    header.appendChild(searchContainer);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const contentDiv = document.createElement('div');
    contentDiv.id = LOG_MODAL_CONTENT_ID;
    Object.assign(contentDiv.style, {
      position: 'absolute',
      top: '40px',
      bottom: '0',
      left: '0',
      right: '0',
      overflowY: 'auto',
      padding: '10px',
      backgroundColor: TERMINAL_COLORS.bg,
      color: TERMINAL_COLORS.text,
      fontSize: '14px',
      lineHeight: '1.5',
      userSelect: 'text',
    });
    modal.appendChild(contentDiv);

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target === searchInput || e.target.closest('button')) return;
      isResizing = true;
      startY = e.clientY;
      startHeight = parseInt(window.getComputedStyle(modal).height, 10);
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dy = startY - e.clientY;
      const newHeight = startHeight + dy;
      if (newHeight > 200) modal.style.height = `${newHeight}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
      }
    });

    searchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      Array.from(contentDiv.getElementsByClassName('log-line')).forEach((line) => {
        line.style.display = line.textContent.toLowerCase().includes(searchTerm) ? 'block' : 'none';
      });
    });

    shadowRoot.appendChild(modal);
    return modal;
  }

  function colorizeLog(logText) {
    if (logText.includes('Error:') || logText.includes('[ERROR]')) {
      return `<span style="color: ${TERMINAL_COLORS.error}">${logText}</span>`;
    }
    if (logText.includes('Warning:') || logText.includes('[WARN]')) {
      return `<span style="color: ${TERMINAL_COLORS.warning}">${logText}</span>`;
    }
    if (logText.includes('Info:') || logText.includes('[INFO]')) {
      return `<span style="color: ${TERMINAL_COLORS.info}">${logText}</span>`;
    }
    return logText;
  }

  function getBaseUrl() {
    return window.LFC_BASE_URL || 'PLEASE_UPDATE';
  }

  function showLogsModal() {
    if (!logsModal) logsModal = createLogsModal();
    logsModal.style.display = 'block';
    state.terminalWasOpen = true;
    saveState();

    const contentDiv = shadowRoot.getElementById(LOG_MODAL_CONTENT_ID);
    contentDiv.innerHTML = '';

    const url = `${getBaseUrl()}/api/v1/builds/${encodeURIComponent(UUID)}/services/${encodeURIComponent(
      SERVICE_NAME
    )}/logs`;
    evtSource = new EventSource(url);

    evtSource.onmessage = (event) => {
      const logLine = document.createElement('div');
      logLine.className = 'log-line';
      logLine.innerHTML = colorizeLog(event.data);
      contentDiv.appendChild(logLine);

      const searchTerm = shadowRoot.getElementById(SEARCH_INPUT_ID).value.toLowerCase();
      if (searchTerm) {
        logLine.style.display = event.data.toLowerCase().includes(searchTerm) ? 'block' : 'none';
      }
      contentDiv.scrollTop = contentDiv.scrollHeight;
    };

    evtSource.onerror = (error) => console.error('SSE error:', error);
  }

  function hideLogsModal() {
    if (logsModal) {
      logsModal.style.display = 'none';
      state.terminalWasOpen = false;
      saveState();

      const buttonContainer = shadowRoot.getElementById(`${LOG_BUTTON_ID}-container`);
      if (buttonContainer && !state.isCollapsed) buttonContainer.style.display = 'block';
    }
    if (evtSource) {
      evtSource.close();
      evtSource = null;
    }
  }

  function hideAll() {
    const wasTerminalOpen = logsModal?.style.display === 'block';

    if (logsModal) {
      logsModal.style.display = 'none';
      if (evtSource) {
        evtSource.close();
        evtSource = null;
      }
    }

    toggleBadge(true);
    state.isHidden = true;
    state.terminalWasOpen = wasTerminalOpen;
    saveState();
  }

  function initShortcut() {
    document.addEventListener('keydown', (event) => {
      if (event.metaKey && event.key === '0') {
        event.preventDefault();
        state.isHidden ? restoreComponents() : hideAll();
      }
    });
  }

  function initialize() {
    createShadowHost();
    loadState();
    initShortcut();

    if (!state.isHidden) {
      if (state.shouldShowBadge) {
        toggleBadge();
      }
      if (state.terminalWasOpen) {
        if (!logsModal) logsModal = createLogsModal();
        showLogsModal();
      }
    }

    setInterval(() => {
      const badge = shadowRoot?.getElementById(BADGE_ID);
      if (badge && !state.isCollapsed) {
        const contentWrapper = badge.querySelector('#badge-content-wrapper');
        if (contentWrapper) {
          contentWrapper.innerHTML = buildBadgeContent();
        }
      }
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
