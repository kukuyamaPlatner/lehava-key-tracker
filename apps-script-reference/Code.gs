/**
 * School Key Tracker — Apps Script backend
 *
 * SETUP:
 * 1. Create a Google Sheet with 3 tabs: keys, log, users
 *    keys:  key_id | name | location | status | holder | last_updated | active
 *    log:   timestamp | key_id | user_id | user_name | action | method | note
 *    users: user_id | name | active
 *    (Header row exactly as above, row 1, columns A onward, in that order.)
 * 2. Put the Sheet's ID below in SHEET_ID.
 * 3. Set ADMIN_PASSCODE to something only managers know.
 * 4. Deploy > New deployment > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 * 5. Copy the deployment URL. Tags get written as:
 *      <deployment_url>?k=K07
 *    Manager screen is:
 *      <deployment_url>?admin=1&pass=YOUR_PASSCODE
 *
 * NOTE: Session.getActiveUser() only reliably identifies visitors when a
 * web app's access is restricted to a Google Workspace domain. Since this
 * app uses "Anyone" access (teachers shouldn't need to sign in), we can't
 * use email-based admin checks — a shared passcode is used instead.
 */

const SHEET_ID = 'PUT_YOUR_SHEET_ID_HERE';
const ADMIN_PASSCODE = 'CHANGE_ME';

const TABS = {
  KEYS: 'keys',
  LOG: 'log',
  USERS: 'users',
};

const KEYS_COLS = ['key_id', 'name', 'location', 'status', 'holder', 'last_updated', 'active'];
const LOG_COLS = ['timestamp', 'key_id', 'user_id', 'user_name', 'action', 'method', 'note'];
const USERS_COLS = ['user_id', 'name', 'active'];

// ---------- doGet router ----------

function doGet(e) {
  const params = e.parameter || {};
  let template;

  if (params.admin) {
    // No passcode check here — Admin.html itself gates access via a
    // login screen, and every admin RPC call re-validates the passcode
    // server-side regardless of how the page was reached.
    template = HtmlService.createTemplateFromFile('Admin');
  } else if (params.k) {
    template = HtmlService.createTemplateFromFile('Scan');
    template.keyId = params.k;
  } else {
    template = HtmlService.createTemplateFromFile('Board');
  }

  return template
    .evaluate()
    .setTitle('מעקב מפתחות')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------- sheet helpers ----------

function sheet_(tabName) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(tabName);
}

function readTab_(tabName, cols) {
  const sh = sheet_(tabName);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  return values.map(function (row, i) {
    const obj = { _row: i + 2 };
    cols.forEach(function (c, idx) {
      obj[c] = row[idx];
    });
    return obj;
  });
}

function appendRow_(tabName, cols, obj) {
  const sh = sheet_(tabName);
  const row = cols.map(function (c) {
    return obj[c] !== undefined ? obj[c] : '';
  });
  sh.appendRow(row);
}

function updateRow_(tabName, cols, rowIndex, obj) {
  const sh = sheet_(tabName);
  const row = cols.map(function (c) {
    return obj[c] !== undefined ? obj[c] : '';
  });
  sh.getRange(rowIndex, 1, 1, cols.length).setValues([row]);
}

function nowIso_() {
  return new Date().toISOString();
}

// ---------- public API: scan screen ----------

function getKeyState(keyId) {
  const keys = readTab_(TABS.KEYS, KEYS_COLS);
  const key = keys.find(function (k) {
    return String(k.key_id) === String(keyId) && k.active !== false && k.active !== 'FALSE';
  });
  if (!key) {
    return { found: false };
  }

  let holderName = '';
  if (key.status === 'out' && key.holder) {
    const users = readTab_(TABS.USERS, USERS_COLS);
    const u = users.find(function (u) {
      return String(u.user_id) === String(key.holder);
    });
    holderName = u ? u.name : key.holder;
  }

  return {
    found: true,
    key_id: key.key_id,
    name: key.name,
    location: key.location,
    status: key.status || 'in',
    holder_id: key.holder || '',
    holder_name: holderName,
    last_updated: key.last_updated || '',
  };
}

function getUsers() {
  const users = readTab_(TABS.USERS, USERS_COLS);
  return users
    .filter(function (u) {
      return u.active !== false && u.active !== 'FALSE';
    })
    .map(function (u) {
      return { user_id: u.user_id, name: u.name };
    });
}

/**
 * Used by the scan screen's free-text name entry.
 * Returns any existing active users whose name matches exactly
 * (case/whitespace-insensitive), so the client can ask "is this you?"
 * rather than silently merging two different people.
 */
function findUserByName(typedName) {
  const name = String(typedName || '').trim();
  const users = readTab_(TABS.USERS, USERS_COLS);
  return users
    .filter(function (u) {
      return (
        (u.active !== false && u.active !== 'FALSE') &&
        String(u.name).trim().toLowerCase() === name.toLowerCase()
      );
    })
    .map(function (u) {
      return { user_id: u.user_id, name: u.name };
    });
}

/**
 * Creates a new user unconditionally — used once the client has
 * confirmed this is a genuinely different person than any existing
 * match. Still re-checks for an exact duplicate at write time (in case
 * two people are creating accounts with the same typed name at once)
 * and refuses rather than silently creating a collision.
 */
function createUniqueUser(typedName) {
  const name = String(typedName || '').trim();
  if (!name) throw new Error('Name is required.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const users = readTab_(TABS.USERS, USERS_COLS);
    const dupe = users.find(function (u) {
      return (
        (u.active !== false && u.active !== 'FALSE') &&
        String(u.name).trim().toLowerCase() === name.toLowerCase()
      );
    });
    if (dupe) {
      // Someone else grabbed this exact name in the meantime.
      throw new Error('DUPLICATE');
    }

    let max = 0;
    users.forEach(function (u) {
      const m = String(u.user_id).match(/^U(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    const newId = 'U' + String(max + 1).padStart(3, '0');

    appendRow_(TABS.USERS, USERS_COLS, {
      user_id: newId,
      name: name,
      active: true,
    });

    return { user_id: newId, name: name };
  } finally {
    lock.releaseLock();
  }
}

/**
 * action: 'out' | 'in'
 * method: 'auto' | 'manual'
 */
function recordAction(keyId, userId, userName, action, method, note) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 1. Always log first — this is the source of truth.
    appendRow_(TABS.LOG, LOG_COLS, {
      timestamp: nowIso_(),
      key_id: keyId,
      user_id: userId,
      user_name: userName,
      action: action,
      method: method || 'auto',
      note: note || '',
    });

    // 2. Then update the cached status on the keys tab.
    const keys = readTab_(TABS.KEYS, KEYS_COLS);
    const key = keys.find(function (k) {
      return String(k.key_id) === String(keyId);
    });
    if (!key) {
      throw new Error('Unknown key_id: ' + keyId);
    }

    const updated = {
      key_id: key.key_id,
      name: key.name,
      location: key.location,
      status: action === 'out' ? 'out' : 'in',
      holder: action === 'out' ? userId : '',
      last_updated: nowIso_(),
      active: key.active,
    };
    updateRow_(TABS.KEYS, KEYS_COLS, key._row, updated);

    return getKeyState(keyId);
  } finally {
    lock.releaseLock();
  }
}

// convenience used by "do the opposite" / mismatch-fix flows on the client
function recordSwap(keyId, fromUserId, fromUserName, toUserId, toUserName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendRow_(TABS.LOG, LOG_COLS, {
      timestamp: nowIso_(),
      key_id: keyId,
      user_id: fromUserId,
      user_name: fromUserName,
      action: 'in',
      method: 'manual',
      note: 'swap → ' + toUserName,
    });
    appendRow_(TABS.LOG, LOG_COLS, {
      timestamp: nowIso_(),
      key_id: keyId,
      user_id: toUserId,
      user_name: toUserName,
      action: 'out',
      method: 'manual',
      note: 'swap ← ' + fromUserName,
    });

    const keys = readTab_(TABS.KEYS, KEYS_COLS);
    const key = keys.find(function (k) {
      return String(k.key_id) === String(keyId);
    });
    updateRow_(TABS.KEYS, KEYS_COLS, key._row, {
      key_id: key.key_id,
      name: key.name,
      location: key.location,
      status: 'out',
      holder: toUserId,
      last_updated: nowIso_(),
      active: key.active,
    });

    return getKeyState(keyId);
  } finally {
    lock.releaseLock();
  }
}

// ---------- public API: board ----------

function getBoard() {
  const keys = readTab_(TABS.KEYS, KEYS_COLS).filter(function (k) {
    return k.active !== false && k.active !== 'FALSE';
  });
  const users = readTab_(TABS.USERS, USERS_COLS);
  const userMap = {};
  users.forEach(function (u) {
    userMap[u.user_id] = u.name;
  });

  const board = keys.map(function (k) {
    return {
      key_id: k.key_id,
      name: k.name,
      location: k.location,
      status: k.status || 'in',
      holder_name: k.status === 'out' ? userMap[k.holder] || k.holder : '',
      last_updated: k.last_updated || '',
    };
  });

  board.sort(function (a, b) {
    if (a.status === b.status) return new Date(a.last_updated) - new Date(b.last_updated);
    return a.status === 'out' ? -1 : 1;
  });

  return board;
}

// ---------- admin API (each re-checks the passcode) ----------

function adminGuard_(pass) {
  if (pass !== ADMIN_PASSCODE) throw new Error('Not authorized.');
}

function adminListKeys(pass) {
  adminGuard_(pass);
  return readTab_(TABS.KEYS, KEYS_COLS);
}

function adminUpsertKey(key, pass) {
  adminGuard_(pass);
  const keys = readTab_(TABS.KEYS, KEYS_COLS);
  const existing = keys.find(function (k) {
    return String(k.key_id) === String(key.key_id);
  });
  if (existing) {
    updateRow_(TABS.KEYS, KEYS_COLS, existing._row, {
      key_id: key.key_id,
      name: key.name,
      location: key.location,
      status: existing.status || 'in',
      holder: existing.holder || '',
      last_updated: existing.last_updated || '',
      active: key.active !== undefined ? key.active : true,
    });
  } else {
    appendRow_(TABS.KEYS, KEYS_COLS, {
      key_id: key.key_id,
      name: key.name,
      location: key.location,
      status: 'in',
      holder: '',
      last_updated: nowIso_(),
      active: true,
    });
  }
  return adminListKeys(pass);
}

function adminNextKeyId(pass) {
  adminGuard_(pass);
  const keys = readTab_(TABS.KEYS, KEYS_COLS);
  let max = 0;
  keys.forEach(function (k) {
    const m = String(k.key_id).match(/^K(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'K' + String(max + 1).padStart(2, '0');
}

function adminRetireKey(keyId, pass) {
  adminGuard_(pass);
  const keys = readTab_(TABS.KEYS, KEYS_COLS);
  const key = keys.find(function (k) {
    return String(k.key_id) === String(keyId);
  });
  if (!key) return adminListKeys(pass);
  updateRow_(TABS.KEYS, KEYS_COLS, key._row, {
    key_id: key.key_id,
    name: key.name,
    location: key.location,
    status: key.status,
    holder: key.holder,
    last_updated: key.last_updated,
    active: false,
  });
  return adminListKeys(pass);
}

function adminListUsers(pass) {
  adminGuard_(pass);
  return readTab_(TABS.USERS, USERS_COLS);
}

function adminNextUserId(pass) {
  adminGuard_(pass);
  const users = readTab_(TABS.USERS, USERS_COLS);
  let max = 0;
  users.forEach(function (u) {
    const m = String(u.user_id).match(/^U(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'U' + String(max + 1).padStart(3, '0');
}

function adminUpsertUser(user, pass) {
  adminGuard_(pass);
  const users = readTab_(TABS.USERS, USERS_COLS);
  const existing = users.find(function (u) {
    return String(u.user_id) === String(user.user_id);
  });
  if (existing) {
    updateRow_(TABS.USERS, USERS_COLS, existing._row, {
      user_id: user.user_id,
      name: user.name,
      active: user.active !== undefined ? user.active : true,
    });
  } else {
    appendRow_(TABS.USERS, USERS_COLS, {
      user_id: user.user_id,
      name: user.name,
      active: true,
    });
  }
  return adminListUsers(pass);
}

function adminDeactivateUser(userId, pass) {
  adminGuard_(pass);
  const users = readTab_(TABS.USERS, USERS_COLS);
  const u = users.find(function (u) {
    return String(u.user_id) === String(userId);
  });
  if (!u) return adminListUsers(pass);
  updateRow_(TABS.USERS, USERS_COLS, u._row, {
    user_id: u.user_id,
    name: u.name,
    active: false,
  });
  return adminListUsers(pass);
}

function adminForceCheckIn(keyId, pass) {
  adminGuard_(pass);
  return recordAction(keyId, 'ADMIN', 'Manager', 'in', 'manual', 'forced check-in');
}

/**
 * Reports
 * type: 'currently_out' | 'by_teacher' | 'key_history'
 */
function adminReport(type, params, pass) {
  adminGuard_(pass);
  const log = readTab_(TABS.LOG, LOG_COLS);

  if (type === 'currently_out') {
    return getBoard().filter(function (k) {
      return k.status === 'out';
    });
  }

  if (type === 'by_teacher') {
    const board = getBoard();
    return board.filter(function (k) {
      return k.status === 'out' && k.holder_name === params.name;
    });
  }

  if (type === 'key_history') {
    return log
      .filter(function (l) {
        return String(l.key_id) === String(params.key_id);
      })
      .sort(function (a, b) {
        return new Date(b.timestamp) - new Date(a.timestamp);
      })
      .slice(0, params.limit || 50);
  }

  return [];
}

/**
 * Replays the full log to rebuild keys.status / keys.holder from scratch.
 * Run this if the Sheet was hand-edited into an inconsistent state.
 */
function adminRebuildStatus(pass) {
  adminGuard_(pass);
  const log = readTab_(TABS.LOG, LOG_COLS).sort(function (a, b) {
    return new Date(a.timestamp) - new Date(b.timestamp);
  });

  const state = {}; // key_id -> {status, holder, last_updated}
  log.forEach(function (entry) {
    state[entry.key_id] = {
      status: entry.action === 'out' ? 'out' : 'in',
      holder: entry.action === 'out' ? entry.user_id : '',
      last_updated: entry.timestamp,
    };
  });

  const keys = readTab_(TABS.KEYS, KEYS_COLS);
  keys.forEach(function (key) {
    const s = state[key.key_id];
    if (!s) return; // key with no history yet — leave as-is (default 'in')
    updateRow_(TABS.KEYS, KEYS_COLS, key._row, {
      key_id: key.key_id,
      name: key.name,
      location: key.location,
      status: s.status,
      holder: s.holder,
      last_updated: s.last_updated,
      active: key.active,
    });
  });

  return adminListKeys(pass);
}
