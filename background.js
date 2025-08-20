console.log("Log-OCS - Background loaded");

// ==== Backend ingest config & helpers ====
const INGEST_CONFIG = {
  DEFAULT_BACKEND_URL: 'http://localhost:8000',
  PATHS: {
    interaction: '/v1/logs/interaction',
    network: '/v1/logs/network',
  },
  MAX_RETRY: 3,
  RETRY_BASE_DELAY_MS: 1000,
};

let _backendUrlCache = null;
async function getBackendUrl() {
  if (_backendUrlCache) return _backendUrlCache;
  try {
    const stored = await chrome.storage.local.get(['backendUrl']);
    _backendUrlCache = stored.backendUrl || INGEST_CONFIG.DEFAULT_BACKEND_URL;
    return _backendUrlCache;
  } catch (e) {
    return INGEST_CONFIG.DEFAULT_BACKEND_URL;
  }
}

async function _postJson(path, events) {
  const urlBase = await getBackendUrl();
  const url = urlBase.replace(/\/$/, '') + path;
  const body = JSON.stringify(events);
  // keepalive=true to allow sending during unload
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return true;
}

async function sendToBackend(kind, events) {
  const path = kind === 'interaction' ? INGEST_CONFIG.PATHS.interaction : INGEST_CONFIG.PATHS.network;
  let attempt = 0;
  while (attempt < INGEST_CONFIG.MAX_RETRY) {
    try {
      await _postJson(path, events);
      console.log(`[ingest] sent ${events.length} ${kind} event(s) to backend`);
      return true;
    } catch (err) {
      attempt++;
      const delay = INGEST_CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[ingest] attempt ${attempt} failed for ${kind}:`, err?.message || err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.error(`[ingest] all retries failed for ${kind}, will keep in buffer`);
  return false;
}
// ==== end helpers ====


// User info storage
let currentUserInfo = {
  username: null,
  sessionId: null,
  url: null,
  domain: null,
  lastUpdated: null
};

// Map tabId -> userInfo để handle multiple tabs
const tabUserInfo = new Map();

// Request tracking system
let requestBuffer = [];
let requestSequence = 0;
const MAX_REQUEST_BUFFER = 50;
const REQUEST_FLUSH_INTERVAL = 5000;

// Generate request ID
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get user info for a specific tab
function getUserInfoForTab(tabId) {
  return tabUserInfo.get(tabId) || currentUserInfo;
}

// Create request event với user info
function createRequestEvent(details, responseDetails = null) {
  const timestamp = Date.now();
  requestSequence++; 
  
  // Lấy user info cho tab này
  const userInfo = getUserInfoForTab(details.tabId);
  
  const requestEvent = {
    eventType: 'HTTP_REQUEST',
    requestId: generateRequestId(),
    timestamp: timestamp,
    sequence: requestSequence,
    
    // User context
    user: {
      username: userInfo.username || 'unknown',
      sessionId: userInfo.sessionId || 'unknown',
      domain: userInfo.domain || (details.url ? new URL(details.url).hostname : 'unknown'),
      pageUrl: userInfo.url || details.documentUrl
    },
    
    // Request details
    request: {
      url: details.url,
      method: details.method,
      type: details.type, // xmlhttprequest, script, image, etc.
      tabId: details.tabId,
      frameId: details.frameId,
      initiator: details.initiator,
      documentUrl: details.documentUrl
    },
    
    // Response details (if available)
    response: responseDetails ? {
      statusCode: responseDetails.statusCode,
      statusLine: responseDetails.statusLine,
      fromCache: responseDetails.fromCache,
      ip: responseDetails.ip
    } : null,
    
    // Timing info
    timing: {
      requestTime: details.timeStamp,
      responseTime: responseDetails ? responseDetails.timeStamp : null,
      duration: responseDetails ? responseDetails.timeStamp - details.timeStamp : null
    }
  };
  
  return requestEvent;
}

// Store requests temporarily to match with responses
const pendingRequests = new Map();

// Flush request buffer
function flushRequests() {
  if (!requestBuffer.length) return;
  
  console.log(`Sending ${requestBuffer.length} HTTP request events...`);
  
  const payload = {
    type: "HTTP_REQUEST_EVENTS",
    events: requestBuffer,
    sentAt: Date.now(),
    summary: {
      totalRequests: requestSequence,
      eventsInBatch: requestBuffer.length,
      users: [...new Set(requestBuffer.map(e => e.user.username))],
      domains: [...new Set(requestBuffer.map(e => e.user.domain))],
      requestTypes: requestBuffer.reduce((acc, event) => {
        acc[event.request.type] = (acc[event.request.type] || 0) + 1;
        return acc;
      }, {}),
      methods: requestBuffer.reduce((acc, event) => {
        acc[event.request.method] = (acc[event.request.method] || 0) + 1;
        return acc;
      }, {})
    }
  };
  
  console.log("Request payload:", {
    type: payload.type,
    eventsCount: payload.events.length,
    sampleEvent: payload.events[0] ? {
      user: payload.events[0].user,
      method: payload.events[0].request.method,
      url: payload.events[0].request.url
    } : null,
    summary: payload.summary
  });
  
  // Send to ingest backend; clear buffer only if success
(async () => {
  try {
    const ok = await sendToBackend('network', requestBuffer);
    if (ok) {
      requestBuffer = [];
    } else {
      console.warn('[ingest] network batch not sent, keeping buffer for retry');
    }
  } catch (e) {
    console.warn('[ingest] network send exception, keeping buffer:', e?.message || e);
  }
})();
}

// Target domains and ports
const TARGET_DOMAINS = [
  '10.207.242.194',
  '10.221.155.1', 
  '10.205.55.204'
];

const TARGET_PORTS = ['8008', '8888', '8088', '8001'];

// Check if URL matches our target domains
function isTargetUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Check if hostname matches any target domain
    if (TARGET_DOMAINS.includes(hostname)) {
      // For 10.205.55.204, check if port is specified and matches our targets
      if (hostname === '10.205.55.204') {
        const port = urlObj.port;
        // Allow default ports (80, 443) or our specific target ports
        return !port || port === '80' || port === '443' || TARGET_PORTS.includes(port);
      }
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Enhanced webRequest listeners
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    try {
      // Skip chrome-extension and chrome internal requests
      if (details.url.startsWith('chrome-extension://') || 
          details.url.startsWith('chrome://') ||
          details.url.startsWith('moz-extension://')) {
        return;
      }
      
      // Only track requests to target domains
      if (!isTargetUrl(details.url)) {
        return;
      }
      
      const requestEvent = createRequestEvent(details);
      
      // Store for matching with response
      pendingRequests.set(details.requestId, {
        event: requestEvent,
        startTime: Date.now()
      });
      
      console.log("Request tracked:", {
        user: requestEvent.user.username,
        method: details.method,
        url: details.url,
        type: details.type,
        tabId: details.tabId
      });
      
    } catch (e) {
      console.error("onBeforeRequest error:", e);
    }
  },
  { 
    urls: [
      "http://10.207.242.194/*",
      "https://10.207.242.194/*",
      "http://10.221.155.1/*", 
      "https://10.221.155.1/*",
      "http://10.205.55.204/*",
      "https://10.205.55.204/*",
      "http://10.205.55.204:8008/*",
      "https://10.205.55.204:8008/*",
      "http://10.205.55.204:8888/*",
      "https://10.205.55.204:8888/*",
      "http://10.205.55.204:8088/*",
      "https://10.205.55.204:8088/*",
      "http://10.205.55.204:8001/*",
      "https://10.205.55.204:8001/*"
    ] 
  }
);

chrome.webRequest.onCompleted.addListener(
  function(details) {
    try {
      // Skip chrome-extension and chrome internal requests
      if (details.url.startsWith('chrome-extension://') || 
          details.url.startsWith('chrome://') ||
          details.url.startsWith('moz-extension://')) {
        return;
      }
      
      // Only track requests to target domains
      if (!isTargetUrl(details.url)) {
        return;
      }
      
      const pendingRequest = pendingRequests.get(details.requestId);
      if (pendingRequest) {
        // Update request event with response data
        const requestEvent = pendingRequest.event;
        requestEvent.response = {
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          fromCache: details.fromCache,
          ip: details.ip
        };
        
        requestEvent.timing.responseTime = details.timeStamp;
        requestEvent.timing.duration = details.timeStamp - requestEvent.timing.requestTime;
        
        // Add to buffer
        requestBuffer.push(requestEvent);
        
        console.log("Request completed:", {
          user: requestEvent.user.username,
          method: requestEvent.request.method,
          url: requestEvent.request.url,
          status: details.statusCode,
          duration: Math.round(requestEvent.timing.duration) + 'ms'
        });
        
        // Remove from pending
        pendingRequests.delete(details.requestId);
        
        // Flush if buffer is full
        if (requestBuffer.length >= MAX_REQUEST_BUFFER) {
          flushRequests();
        }
      }
      
    } catch (e) {
      console.error("onCompleted error:", e);
    }
  },
  { 
    urls: [
      "http://10.207.242.194/*",
      "https://10.207.242.194/*",
      "http://10.221.155.1/*", 
      "https://10.221.155.1/*",
      "http://10.205.55.204/*",
      "https://10.205.55.204/*",
      "http://10.205.55.204:8008/*",
      "https://10.205.55.204:8008/*",
      "http://10.205.55.204:8888/*",
      "https://10.205.55.204:8888/*",
      "http://10.205.55.204:8088/*",
      "https://10.205.55.204:8088/*",
      "http://10.205.55.204:8001/*",
      "https://10.205.55.204:8001/*"
    ] 
  }
);

chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    try {
      // Only track requests to target domains
      if (!isTargetUrl(details.url)) {
        return;
      }
      
      const pendingRequest = pendingRequests.get(details.requestId);
      if (pendingRequest) {
        const requestEvent = pendingRequest.event;
        requestEvent.response = {
          error: details.error,
          statusCode: 0,
          statusLine: `ERROR: ${details.error}`
        };
        
        requestEvent.timing.responseTime = details.timeStamp;
        requestEvent.timing.duration = details.timeStamp - requestEvent.timing.requestTime;
        
        requestBuffer.push(requestEvent);
        
        console.log("Request failed:", {
          user: requestEvent.user.username,
          method: requestEvent.request.method,
          url: requestEvent.request.url,
          error: details.error
        });
        
        pendingRequests.delete(details.requestId);
      }
    } catch (e) {
      console.error("onErrorOccurred error:", e);
    }
  },
  { 
    urls: [
      "http://10.207.242.194/*",
      "https://10.207.242.194/*",
      "http://10.221.155.1/*", 
      "https://10.221.155.1/*",
      "http://10.205.55.204/*",
      "https://10.205.55.204/*",
      "http://10.205.55.204:8008/*",
      "https://10.205.55.204:8008/*",
      "http://10.205.55.204:8888/*",
      "https://10.205.55.204:8888/*",
      "http://10.205.55.204:8088/*",
      "https://10.205.55.204:8088/*",
      "http://10.205.55.204:8001/*",
      "https://10.205.55.204:8001/*"
    ] 
  }
);

// Enhanced message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    console.log("Message received in background:", msg.type);
    
    if (msg && msg.type === "USER_INFO_UPDATE") {
      // Update user info
      const tabId = sender && sender.tab ? sender.tab.id : null;
      
      if (tabId) {
        tabUserInfo.set(tabId, {
          username: msg.data.username,
          sessionId: msg.data.sessionId,
          url: msg.data.url,
          domain: msg.data.domain,
          lastUpdated: msg.data.timestamp
        });
      }
      
      // Update global user info (fallback)
      currentUserInfo = {
        username: msg.data.username,
        sessionId: msg.data.sessionId,
        url: msg.data.url,
        domain: msg.data.domain,
        lastUpdated: msg.data.timestamp
      };
      
      console.log("User info updated:", {
        tabId: tabId,
        username: msg.data.username,
        domain: msg.data.domain,
        sessionId: msg.data.sessionId
      });
      
      sendResponse({ ok: true, message: "User info updated" });
      
    } else if (msg && msg.type === "USER_INTERACTION_EVENTS" && Array.isArray(msg.events)) {
      // Handle user interaction events
      const tabId = sender && sender.tab ? sender.tab.id : null;
      
      console.log("User interaction events received:", {
        count: msg.events.length,
        url: sender.tab?.url,
        sessionId: msg.sessionSummary?.sessionId,
        sessionDuration: Math.round(msg.sessionSummary?.sessionDuration / 1000) + 's',
        interactions: msg.events.map(e => ({
          user: e.user,
          type: e.source === 2 ? 'click' : 'input',
          element: e.domInfo?.tagName,
          id: e.domInfo?.id,
          class: e.domInfo?.className,
          value: e.inputValue || e.domInfo?.textContent,
          timestamp: new Date(e.timestamp).toLocaleTimeString()
        }))
      });
      
      // Log detailed interactions
      msg.events.forEach(event => {
        if (event.domInfo) {
          console.log("User interaction detail:", {
            user: event.user,
            type: event.source === 2 ? 'click' : 'input',
            element: {
              tag: event.domInfo.tagName,
              id: event.domInfo.id,
              class: event.domInfo.className,
              type: event.domInfo.type,
              value: event.domInfo.value
            },
            coordinates: event.eventData?.coordinates,
            nodeId: event.eventData?.nodeId
          });
        }
      });
      
      // TODO: Send to analytics backend
      // fetch('https://your-analytics-endpoint/user-interactions', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     type: 'user_interactions',
      //     url: sender.tab?.url,
      //     tabId: tabId,
      //     interactions: msg.events,
      //     sessionSummary: msg.sessionSummary
      //   })
      // });
      
      
      // Forward interactions to ingest backend (fire-and-forget)
      (async () => {
        try {
          await sendToBackend('interaction', msg.events);
        } catch (e) {
          console.warn('[ingest] interaction forward failed:', e?.message || e);
        }
      })();
      sendResponse({ ok: true, processed: msg.events.length });
      
    } else {
      console.log("Unknown message type or invalid format");
      sendResponse({ ok: false, error: "Invalid message format" });
    }
  } catch (e) {
    console.error("Background error:", e);
    sendResponse({ ok: false, error: e.message });
  }
  
  return true;
});

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  tabUserInfo.delete(tabId);
  console.log(`Cleaned up user info for closed tab ${tabId}`);
});

// Periodic flush for requests
setInterval(() => {
  if (requestBuffer.length > 0) {
    flushRequests();
  }
}, REQUEST_FLUSH_INTERVAL);

console.log("Log-OCS ready - tracking HTTP requests with user context");