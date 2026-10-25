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

  const LINK_STYLES = 'color: #4CAF50; text-decoration: none; border-bottom: 1px dotted #4CAF50;';
  const BADGE_ID = 'versionBadge';
  const LOGS_BUTTON_ID = 'openLogsButton';

  let shadowRoot = null;
  const state = {
    isHidden: true,
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
    addLogsButton(badge);
    shadowRoot.appendChild(badge);
    saveState();
  }

  function saveState() {
    localStorage.setItem('componentsHidden', state.isHidden);
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
    const buttonContainer = shadowRoot.getElementById(`${LOGS_BUTTON_ID}-container`);
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
      if (buttonContainer) buttonContainer.style.display = 'block';
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

  function addLogsButton(badge) {
    let environmentUrl;
    try {
      environmentUrl = new URL(window.LFC_ENVIRONMENT_URL || window.LFC_DASHBOARD_URL || '');
      if (!['https:', 'http:'].includes(environmentUrl.protocol)) return;
    } catch {
      return;
    }

    const buttonContainer = document.createElement('div');
    buttonContainer.id = `${LOGS_BUTTON_ID}-container`;
    Object.assign(buttonContainer.style, {
      padding: '8px 15px 15px 15px',
      borderTop: '1px solid rgba(255, 255, 255, 0.1)',
      marginTop: '10px',
      display: state.isCollapsed ? 'none' : 'block',
    });

    const btn = document.createElement('button');
    btn.id = LOGS_BUTTON_ID;
    btn.textContent = 'View logs';
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
      window.open(environmentUrl.toString(), '_blank', 'noopener,noreferrer');
    });

    buttonContainer.appendChild(btn);
    badge.appendChild(buttonContainer);
  }

  function hideAll() {
    toggleBadge(true);
    state.isHidden = true;
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

    if (!state.isHidden && state.shouldShowBadge) {
      toggleBadge();
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
