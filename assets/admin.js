// Admin screen (?admin=1) — passcode login, keys/users/board/reports tabs.
const LS_ADMIN_PASS = 'keytracker_admin_pass';
let ADMIN_PASS = null;

function render(html) {
  document.getElementById('app').innerHTML = html;
}

// JSON.stringify() output is wrapped in double quotes, which breaks if
// embedded raw inside a double-quoted onclick="..." attribute (the first
// `"` in the JSON closes the attribute early). Escape those quotes as HTML
// entities so the browser reconstitutes valid JS after parsing the tag.
function j(value) {
  return JSON.stringify(value).replace(/"/g, '&quot;');
}

// The scan URL to write onto a tag for a given key_id. GitHub Pages serves
// index.html for a bare directory request, so the URL can skip the
// filename entirely — shorter, and easier to type by hand if ever needed.
function scanUrlFor(keyId) {
  return new URL('./?k=' + encodeURIComponent(keyId), location.href).href;
}

function copyKeyUrl(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () {
      alert('הקישור הועתק');
    }, function () {
      alert(url);
    });
  } else {
    alert(url);
  }
}

// ---------- boot: try a remembered passcode first ----------
function boot() {
  const stored = localStorage.getItem(LS_ADMIN_PASS);
  if (stored) {
    tryLogin(stored, true);
  } else {
    showLogin();
  }
}

function showLogin(errorMsg) {
  render(
    '<div class="card">' +
    '<h1>כניסת מנהל</h1>' +
    (errorMsg ? '<p style="color:#d70015;">' + errorMsg + '</p>' : '') +
    '<input type="password" id="passBox" placeholder="קוד גישה" onkeydown="if(event.key===\'Enter\')submitLogin()">' +
    '<button class="primary" onclick="submitLogin()">כניסה</button>' +
    '</div>'
  );
  document.getElementById('passBox').focus();
}

function submitLogin() {
  const val = document.getElementById('passBox').value.trim();
  if (!val) return;
  render('<div class="card"><div class="spinner"></div></div>');
  tryLogin(val, false);
}

function tryLogin(pass, isAutoLogin) {
  rpc('admin_list_keys', { p_pass: pass })
    .then(function () {
      ADMIN_PASS = pass;
      localStorage.setItem(LS_ADMIN_PASS, pass);
      showTab('keys');
    })
    .catch(function () {
      if (isAutoLogin) {
        localStorage.removeItem(LS_ADMIN_PASS);
        showLogin();
      } else {
        showLogin('קוד שגוי, נסה שוב');
      }
    });
}

function logout() {
  localStorage.removeItem(LS_ADMIN_PASS);
  ADMIN_PASS = null;
  showLogin();
}

// ---------- main admin UI ----------
let currentTab = 'keys';

function showTab(tab) {
  currentTab = tab;
  render(
    '<div class="card">' +
    '<h1>ניהול מפתחות</h1>' +
    '<div class="tabs">' +
    '<button id="tab-keys" onclick="showTab(\'keys\')">מפתחות</button>' +
    '<button id="tab-users" onclick="showTab(\'users\')">משתמשים</button>' +
    '<button id="tab-board" onclick="showTab(\'board\')">לוח חי</button>' +
    '<button id="tab-reports" onclick="showTab(\'reports\')">דוחות</button>' +
    '</div>' +
    '<div id="panel"></div>' +
    '</div>' +
    '<div class="link-row"><span class="link" onclick="logout()">התנתק</span></div>'
  );
  ['keys', 'users', 'board', 'reports'].forEach(function (t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
  });
  if (tab === 'keys') renderKeysTab();
  if (tab === 'users') renderUsersTab();
  if (tab === 'board') renderBoardTab();
  if (tab === 'reports') renderReportsTab();
}

// ---------- Keys tab ----------
function renderKeysTab() {
  document.getElementById('panel').innerHTML = '<div class="spinner"></div>';
  rpc('admin_list_keys', { p_pass: ADMIN_PASS }).then(function (keys) {
    let html = '<button class="primary" onclick="newKeyForm()">+ מפתח חדש</button>';
    html += '<table><tr><th>מזהה</th><th>שם</th><th>מיקום</th><th>סטטוס</th><th>קישור לתג</th><th>פעולות</th></tr>';
    keys.filter(function (k) { return k.active !== false; }).forEach(function (k) {
      html += '<tr><td>' + k.key_id + '</td><td>' + k.name + '</td><td>' + (k.location || '') + '</td>' +
        '<td>' + (k.status === 'out' ? 'בחוץ' : 'זמין') + '</td>' +
        '<td><span class="link" onclick="copyKeyUrl(' + j(scanUrlFor(k.key_id)) + ')" style="font-size:12px;">העתק קישור</span></td>' +
        '<td><span class="link" onclick="editKeyForm(' + j(k) + ')">ערוך</span> ' +
        '<span class="link" onclick="retireKey(\'' + k.key_id + '\')">בטל</span></td></tr>';
    });
    html += '</table>';
    html += '<div id="keyForm"></div>';
    document.getElementById('panel').innerHTML = html;
  });
}

function newKeyForm() {
  rpc('admin_next_key_id', { p_pass: ADMIN_PASS }).then(function (nextId) {
    showKeyForm({ key_id: nextId, name: '', location: '' }, true);
  });
}

function editKeyForm(key) {
  showKeyForm(key, false);
}

function showKeyForm(key, isNew) {
  const html =
    '<div class="card">' +
    '<h1>' + (isNew ? 'מפתח חדש' : 'עריכת מפתח') + '</h1>' +
    '<p class="muted">מזהה תג: <b>' + key.key_id + '</b></p>' +
    '<p class="muted" style="word-break:break-all;">קישור לתג: ' + scanUrlFor(key.key_id) + '</p>' +
    '<button class="secondary" onclick="copyKeyUrl(' + j(scanUrlFor(key.key_id)) + ')">העתק קישור</button>' +
    '<input type="text" id="kName" placeholder="שם, למשל מעבדת מדעים" value="' + (key.name || '') + '">' +
    '<input type="text" id="kLocation" placeholder="מיקום (אופציונלי)" value="' + (key.location || '') + '">' +
    '<button class="primary" onclick="saveKey(\'' + key.key_id + '\')">שמור</button>' +
    '</div>';
  document.getElementById('keyForm').innerHTML = html;
}

function saveKey(keyId) {
  const name = document.getElementById('kName').value.trim();
  const location = document.getElementById('kLocation').value.trim();
  if (!name) { alert('נא להזין שם'); return; }
  rpc('admin_upsert_key', { p_key: { key_id: keyId, name: name, location: location }, p_pass: ADMIN_PASS })
    .then(renderKeysTab);
}

function retireKey(keyId) {
  if (!confirm('לבטל את המפתח ' + keyId + '?')) return;
  rpc('admin_retire_key', { p_key_id: keyId, p_pass: ADMIN_PASS }).then(renderKeysTab);
}

// ---------- Users tab ----------
function renderUsersTab() {
  document.getElementById('panel').innerHTML = '<div class="spinner"></div>';
  rpc('admin_list_users', { p_pass: ADMIN_PASS }).then(function (users) {
    let html = '<button class="primary" onclick="newUserForm()">+ משתמש חדש</button>';
    html += '<table><tr><th>שם</th><th>פעולות</th></tr>';
    users.filter(function (u) { return u.active !== false; }).forEach(function (u) {
      html += '<tr><td>' + u.name + '</td>' +
        '<td><span class="link" onclick="deactivateUser(\'' + u.user_id + '\')">השבת</span> ' +
        '<span class="link" onclick="deleteUser(' + j(u.user_id) + ',' + j(u.name) + ')" style="color:#d70015;">מחק</span></td></tr>';
    });
    html += '</table><div id="userForm"></div>';
    document.getElementById('panel').innerHTML = html;
  });
}

function newUserForm() {
  rpc('admin_next_user_id', { p_pass: ADMIN_PASS }).then(function (nextId) {
    document.getElementById('userForm').innerHTML =
      '<div class="card"><h1>משתמש חדש</h1>' +
      '<input type="text" id="uName" placeholder="שם מלא">' +
      '<button class="primary" onclick="saveUser(\'' + nextId + '\')">שמור</button></div>';
  });
}

function saveUser(userId) {
  const name = document.getElementById('uName').value.trim();
  if (!name) { alert('נא להזין שם'); return; }
  rpc('admin_upsert_user', { p_user: { user_id: userId, name: name }, p_pass: ADMIN_PASS })
    .then(renderUsersTab);
}

function deactivateUser(userId) {
  if (!confirm('להשבית משתמש זה?')) return;
  rpc('admin_deactivate_user', { p_user_id: userId, p_pass: ADMIN_PASS }).then(renderUsersTab);
}

function deleteUser(userId, userName) {
  if (!confirm('למחוק לצמיתות את ' + userName + '? היסטוריית הלוג שלו תישמר, אבל לא ניתן לבטל פעולה זו.')) return;
  rpc('admin_delete_user', { p_user_id: userId, p_pass: ADMIN_PASS })
    .then(renderUsersTab)
    .catch(function (err) {
      if (String(err.message || err).indexOf('HOLDING_KEY') !== -1) {
        alert('לא ניתן למחוק — המשתמש מחזיק כרגע במפתח. יש להחזיר את המפתח קודם.');
      } else {
        alert('שגיאה במחיקת המשתמש.');
      }
    });
}

// ---------- Live board tab ----------
function renderBoardTab() {
  document.getElementById('panel').innerHTML = '<div class="spinner"></div>';
  rpc('get_board').then(function (board) {
    let html = '<table><tr><th>מפתח</th><th>סטטוס</th><th>אצל</th><th>פעולות</th></tr>';
    board.forEach(function (k) {
      html += '<tr><td>' + k.name + '</td><td>' + (k.status === 'out' ? 'בחוץ' : 'זמין') + '</td>' +
        '<td>' + (k.holder_name || '—') + '</td>' +
        '<td>' + (k.status === 'out' ? '<span class="link" onclick="forceCheckIn(\'' + k.key_id + '\')">אלץ החזרה</span>' : '') + '</td></tr>';
    });
    html += '</table>';
    html += '<div class="link-row"><span class="link" onclick="rebuild()">בנה מחדש סטטוסים מהלוג</span></div>';
    document.getElementById('panel').innerHTML = html;
  });
}

function forceCheckIn(keyId) {
  if (!confirm('לאלץ החזרה של מפתח זה?')) return;
  rpc('admin_force_check_in', { p_key_id: keyId, p_pass: ADMIN_PASS }).then(renderBoardTab);
}

function rebuild() {
  if (!confirm('לבנות מחדש את כל הסטטוסים מהלוג? פעולה זו דורסת סטטוסים ידניים שגויים.')) return;
  rpc('admin_rebuild_status', { p_pass: ADMIN_PASS }).then(function () {
    alert('בוצע.');
    renderBoardTab();
  });
}

// ---------- Reports tab ----------
function renderReportsTab() {
  document.getElementById('panel').innerHTML =
    '<div class="card"><h1>דוחות</h1>' +
    '<button class="secondary" onclick="runReport(\'currently_out\')">מפתחות בחוץ כרגע</button>' +
    '<input type="text" id="teacherName" placeholder="שם מורה, למשל משה כהן">' +
    '<button class="secondary" onclick="runReport(\'by_teacher\')">מה יש אצל מורה זה</button>' +
    '</div>' +
    '<div id="reportResult"></div>';
}

function runReport(type) {
  const params = {};
  if (type === 'by_teacher') {
    params.name = document.getElementById('teacherName').value.trim();
  }
  document.getElementById('reportResult').innerHTML = '<div class="spinner"></div>';
  rpc('admin_report', { p_type: type, p_params: params, p_pass: ADMIN_PASS }).then(function (rows) {
    if (!rows.length) {
      document.getElementById('reportResult').innerHTML = '<p class="muted">אין תוצאות.</p>';
      return;
    }
    let html = '<table><tr><th>מפתח</th><th>אצל</th><th>מזה</th></tr>';
    rows.forEach(function (r) {
      html += '<tr><td>' + r.name + '</td><td>' + (r.holder_name || '') + '</td><td>' + (r.last_updated || '') + '</td></tr>';
    });
    html += '</table>';
    document.getElementById('reportResult').innerHTML = html;
  });
}

boot();
