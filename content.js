console.log("Extension content script loaded");

const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
  MediaInteraction: 7,
  StyleSheetRule: 8,
  CanvasMutation: 9,
  Font: 10,
  Log: 11,
  Drag: 12
};

let sessionId;
let pageId;
let buffer = [];
let username = null;
let sessionStartTime = Date.now();
let lastActivityTime = Date.now();
let eventSequence = 0;
let nodeIdToElementMap = new Map(); // Map nodeId -> DOM element
let currentSnapshot = null;

const MAX_BUFFER = 20;
const FLUSH_INTERVAL = 3000;

function uuid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() :
    Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Build mapping từ rrweb snapshot để map nodeId với DOM elements
function buildNodeIdMapping(snapshot) {
  try {
    if (!snapshot || !snapshot.childNodes) return;
    
    nodeIdToElementMap.clear();
    console.log("Building nodeId to DOM element mapping...");
    
    function traverseSnapshot(nodes, domContext = document) {
      if (!nodes) return;
      
      for (const node of nodes) {
        if (node.type === 2 && node.tagName) { // Element node
          const tagName = node.tagName.toLowerCase();
          let domElement = null;
          
          // Strategy 1: Find by unique ID
          if (node.attributes?.id) {
            domElement = document.getElementById(node.attributes.id);
            if (domElement) {
              nodeIdToElementMap.set(node.id, domElement);
              console.log(`Mapped by ID: nodeId ${node.id} -> ${tagName}#${node.attributes.id}`);
            }
          }
          
          // Strategy 2: Find by class + tag combination
          if (!domElement && node.attributes?.class) {
            const className = node.attributes.class.split(' ')[0];
            const candidates = document.querySelectorAll(`${tagName}.${className}`);
            
            if (candidates.length === 1) {
              domElement = candidates[0];
              nodeIdToElementMap.set(node.id, domElement);
              console.log(`Mapped by class: nodeId ${node.id} -> ${tagName}.${className}`);
            } else if (candidates.length > 1 && node.textContent) {
              // Find by text content if multiple matches
              for (const candidate of candidates) {
                const candidateText = candidate.textContent?.trim();
                const nodeText = node.textContent?.trim();
                if (candidateText && nodeText && candidateText.includes(nodeText)) {
                  domElement = candidate;
                  nodeIdToElementMap.set(node.id, domElement);
                  console.log(`Mapped by text: nodeId ${node.id} -> ${tagName} with text "${nodeText.substring(0, 20)}"`);
                  break;
                }
              }
            }
          }
          
          // Strategy 3: Find by form elements (name attribute)
          if (!domElement && node.attributes?.name && (tagName === 'input' || tagName === 'select' || tagName === 'textarea')) {
            domElement = document.querySelector(`${tagName}[name="${node.attributes.name}"]`);
            if (domElement) {
              nodeIdToElementMap.set(node.id, domElement);
              console.log(`Mapped by name: nodeId ${node.id} -> ${tagName}[name="${node.attributes.name}"]`);
            }
          }
          
          // Recursively process children
          if (node.childNodes) {
            traverseSnapshot(node.childNodes, domElement || domContext);
          }
        }
      }
    }
    
    traverseSnapshot([snapshot]);
    console.log(`NodeId mapping completed: ${nodeIdToElementMap.size} elements mapped`);
  } catch (error) {
    console.error("Error building nodeId mapping:", error);
  }
}

// Lấy DOM element bằng nodeId hoặc fallback methods
function getDOMElementByNodeId(nodeId, event) {
  try {
    // Method 1: Sử dụng nodeId mapping
    if (nodeIdToElementMap.has(nodeId)) {
      const element = nodeIdToElementMap.get(nodeId);
      console.log(`Found element by nodeId ${nodeId}:`, element.tagName, element.id || element.className);
      return element;
    }
    
    // Method 2: Fallback bằng coordinates
    if (event && event.data.x !== undefined && event.data.y !== undefined) {
      const element = document.elementFromPoint(event.data.x, event.data.y);
      if (element) {
        // Cache mapping cho lần sau
        nodeIdToElementMap.set(nodeId, element);
        console.log(`Found element by coordinates and cached: nodeId ${nodeId} -> ${element.tagName}`);
        return element;
      }
    }
    
    console.log(`Could not find element for nodeId ${nodeId}`);
    return null;
  } catch (error) {
    console.error("Error getting DOM element:", error);
    return null;
  }
}

function safeStr(val) {
  return (typeof val === "string" && val.trim() !== "") ? val : null;
}

function safeNum(val) {
  return Number.isFinite(val) ? val : null;
}

function safeBool(val) {
  return Boolean(val);
}


// Lấy thông tin chi tiết từ DOM element
function getDOMElementInfo(event) {
  try {
    const nodeId = event.data.id;
    if (!nodeId) return null;
    
    const element = getDOMElementByNodeId(nodeId, event);
    if (!element) return null;
    
    const rect = element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(element);
    
  return {
  // Element basics
  tagName: safeStr(element.tagName)?.toLowerCase() || null,
  id: safeStr(element.id),
  className: safeStr(element.className),
  type: safeStr(element.type),
  name: safeStr(element.name),
  value: safeStr(element.value),
  textContent: safeStr(element.textContent),
  placeholder: safeStr(element.placeholder),
  href: safeStr(element.href),

  // Position & size
  position: {
    x: safeNum(Math.round(rect.left)),
    y: safeNum(Math.round(rect.top)),
    width: safeNum(Math.round(rect.width)),
    height: safeNum(Math.round(rect.height))
  },

  // Element state
  disabled: safeBool(element.disabled),
  readonly: safeBool(element.readOnly),
  checked: safeBool(element.checked),
  required: safeBool(element.required),
  visible: !(computedStyle.display === "none" || computedStyle.visibility === "hidden"),

  // Parent context
  parent: element.parentElement ? {
    tagName: safeStr(element.parentElement.tagName)?.toLowerCase() || null,
    id: safeStr(element.parentElement.id),
    className: safeStr(element.parentElement.className)
  } : null,

  // Form context
  form: element.form ? {
    id: safeStr(element.form.id),
    action: safeStr(element.form.action),
    method: safeStr(element.form.method)
  } : null,


  };

  } catch (error) {
    console.error("Error getting DOM element info:", error);
    return null;
  }
}

// Lấy thông tin về page context
function getPageContext() {
  return {
    url: location.href,
    path: location.pathname,
    title: document.title,
    domain: location.hostname
  };
}

// Lấy username
function getUsernameFromDOM() {
  try {
    const usernameElement = document.querySelector('.header__username.name-tooltip.name-tooltip__avatar div');
    if (usernameElement && usernameElement.textContent) {
      return usernameElement.textContent.trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Thêm function để gửi user info đến background
async function sendUserInfoToBackground() {
  if (username && sessionId) {
    const userInfo = {
      type: "USER_INFO_UPDATE",
      data: {
        username: username,
        sessionId: sessionId,
        url: location.href,
        domain: location.hostname,
        timestamp: Date.now()
      }
    };
    // Gửi bắt đầu session đến backend-2
    try{
      let res = await fetch("http://localhost:8001/v1/sessions/start", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username,
        sessionId: sessionId,
        startedAt: Date.now()
      }),
      keepalive: true,
    });
      if(res)
        console.log(res);
    }
    catch(e)
    {
      console.log(e);
    }
     
      

    
    try {
      chrome.runtime.sendMessage(userInfo, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Error sending user info:", chrome.runtime.lastError);
        } else {
          console.log("User info sent to background:", response);
        }
      });
    } catch (e) {
      console.error("Failed to send user info:", e);
    }
  }
}

// Cập nhật function waitForUsername
async function waitForUsername() {
  while(true){
    const foundUsername = getUsernameFromDOM();
    if (foundUsername) {
      console.log("Username found:", foundUsername);
      // Gửi user info đến background ngay khi tìm thấy
      setTimeout(sendUserInfoToBackground, 500);
      return foundUsername;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// Thêm listener cho URL changes để update user info
let lastUrl = location.href;
function checkUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // Gửi user info update khi URL thay đổi
    setTimeout(sendUserInfoToBackground, 1000);
  }
}

// Monitor URL changes
setInterval(checkUrlChange, 2000);

function getOrCreateSessionId() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "GET_SESSION_ID" }, (resp) => {
        if (!chrome.runtime.lastError && resp?.ok && resp?.sessionId) {
          resolve(resp.sessionId); // <-- mọi tab sẽ nhận cùng 1 ID
        } else {
          // fallback an toàn (ít khi cần tới)
          resolve(uuid());
        }
      });
    } catch {
      resolve(uuid());
    }
  });
}

// CHỈ track user interactions: clicks và inputs
function shouldTrack(event) {
  if (!event || !event.data) return false;
  
  const source = event.data.source;
  
  // Chỉ track clicks và inputs - BỎ mutations
  return source === IncrementalSource.MouseInteraction ||
         source === IncrementalSource.Input;
}

// Tạo user event chỉ cho interactions
function createUserEvent(event) {
  const timestamp = Date.now();
  const source = event.data.source;
  
  const timeSinceLastActivity = timestamp - lastActivityTime;
  lastActivityTime = timestamp;
  eventSequence++;
  
  const userEvent = {
    user: username,
    timestamp: timestamp,
    source: source == 2 ? "click" : "Input", // 2 for MouseInteraction, 5 for Input
    sessionId: sessionId,
    eventSequence: eventSequence,
    sessionDuration: timestamp - sessionStartTime,
    pageContext: getPageContext(),
    domInfo: getDOMElementInfo(event),
    eventData: {
      nodeId: event.data.id || null,
      coordinates: event.data.x && event.data.y ? {
        x: event.data.x,
        y: event.data.y
      } : null
    }
  };
  
  // Thêm thông tin specific cho từng loại interaction
  if (source === IncrementalSource.MouseInteraction) {
    userEvent.interactionType = event.data.type; // click, dblclick, etc.
  } else if (source === IncrementalSource.Input) {
    userEvent.inputType = event.data.text ? 'text' : 'change';
    userEvent.inputValue = event.data.text || null;
  }
  
  // Log event để debug
  console.log("Created user event:", {
    user: userEvent.user,
    source: userEvent.source,
    hasdomInfo: !!userEvent.domInfo,
    element: userEvent.domInfo?.tagName
  });
  
  return userEvent;
}


function flush() {
  if (!buffer.length) return;
  
  console.log(`Sending ${buffer.length} user interaction events...`);

// Optional: direct ingest fallback (disabled by default).
// If you set chrome.storage.local.set({ backendUrl: 'http://localhost:8000' }),
// content script can POST directly when background fails.
async function directIngestToBackend(events) {
  try {
    const stored = await chrome.storage.local.get(['backendUrl']);
    const base = stored.backendUrl || 'http://localhost:8000';
    const url = base.replace(/\/$/, '') + '/v1/logs/interaction';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      keepalive: true,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    console.log('[direct-ingest] sent', events.length, 'interaction event(s)');
  } catch (e) {
    console.warn('[direct-ingest] failed:', e?.message || e);
  }
}

  
  // Đảm bảo format message chính xác
  const payload = {
    type: "USER_INTERACTION_EVENTS",
    events: buffer, // Array của user events
    sentAt: Date.now(),
    sessionSummary: {
      sessionId: sessionId,
      totalInteractions: eventSequence,
      sessionDuration: Date.now() - sessionStartTime,
      eventsInBatch: buffer.length
    }
  };
  
  // Log payload để debug
  console.log("Payload being sent:", {
    type: payload.type,
    eventsCount: payload.events.length,
    sampleEvent: payload.events[0],
    sessionSummary: payload.sessionSummary
  });
  
  try {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error sending events:", chrome.runtime.lastError);
      } else {
        console.log("User interactions sent successfully:", response);
      }
    });
  } catch (e) {
    console.error("Send failed:", e);
  }
  
  buffer = [];
}

function startTracking() {
  if (typeof rrweb === "undefined") {
    console.error("rrweb not loaded");
    return;
  }

  console.log("Starting user interaction tracking (clicks & inputs only)...");
  
  rrweb.record({
    emit(event) {
      // Build nodeId mapping từ full snapshot
      if (event.type === 2) { // FullSnapshot
        currentSnapshot = event.data;
        buildNodeIdMapping(event.data);
        return; // Không track snapshot events
      }
      
      // CHỈ track user interactions
      if (!shouldTrack(event)) return;
      
      const userEvent = createUserEvent(event);
      
      console.log("User interaction tracked:", {
        user: userEvent.user,
        type: userEvent.source === IncrementalSource.MouseInteraction ? 'click' : 'input',
        nodeId: userEvent.eventData.nodeId,
        element: userEvent.domInfo?.tagName,
        id: userEvent.domInfo?.id,
        class: userEvent.domInfo?.className,
        value: userEvent.inputValue || userEvent.domInfo?.textContent?.substring(0, 20)
      });
      
      buffer.push(userEvent);
      
      if (buffer.length >= MAX_BUFFER) {
        flush();
      }
    },
    sampling: {
      mousemove: false,      // Không track mouse movement
      touchmove: false,      // Không track touch movement  
      scroll: false,         // Không track scroll
      mouseInteraction: true, // Track clicks
      input: true,           // Track inputs
      media: false           // Không track media
    },
    recordCanvas: false,
    collectFonts: false,
    maskAllInputs: false
  });
  
  console.log("User interaction tracking started (clicks & inputs only)");
}

// Setup
setInterval(() => {
  if (buffer.length > 0) flush();
}, FLUSH_INTERVAL);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

window.addEventListener("beforeunload", () => flush());

// Main
(async function main() {
  try {
    
    

    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    username = await waitForUsername();
    sessionId = await getOrCreateSessionId();
    pageId = uuid();
    sendUserInfoToBackground();
    
    startTracking();
  } catch (error) {
    console.error("Initialization error:", error);
  }
})();