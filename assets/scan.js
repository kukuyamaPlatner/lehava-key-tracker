// Scan screen (?k=<key_id>) — identity flow + key state actions.
const LS_USER = 'keytracker_user';
const KEY_ID = new URLSearchParams(location.search).get('k');

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(LS_USER));
  } catch (e) {
    return null;
  }
}
function setStoredUser(user) {
  localStorage.setItem(LS_USER, JSON.stringify(user));
}
function clearStoredUser() {
  localStorage.removeItem(LS_USER);
}

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

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return mins + ' דקות';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' שעות';
  const days = Math.round(hrs / 24);
  return days + ' ימים';
}

// ---------- boot ----------
// Paint the shell instantly (key id + spinner), then fetch state async.
function boot() {
  render('<div class="card"><h1>' + KEY_ID + '</h1><div class="spinner"></div></div>');
  const user = getStoredUser();
  if (!user) {
    showNamePicker();
  } else {
    loadKeyState(user);
  }
}

// ---------- name entry (first run) ----------
function showNamePicker() {
  render(
    '<div class="card">' +
    '<h1>מי אתה?</h1>' +
    '<p class="muted">הקלד את שמך. נזכור אותך בפעם הבאה, לא תצטרך להקליד שוב.</p>' +
    '<input type="text" id="nameBox" placeholder="שם מלא" autofocus oninput="suggestNames()" onkeydown="if(event.key===\'Enter\')confirmName()">' +
    '<div class="name-list" id="suggestions"></div>' +
    '<button class="primary" onclick="confirmName()">המשך</button>' +
    '</div>'
  );
  rpc('get_users').then(function (users) {
    window._allUsers = users;
  });
}

function suggestNames() {
  const q = document.getElementById('nameBox').value.trim().toLowerCase();
  const box = document.getElementById('suggestions');
  if (!q || !window._allUsers) { box.innerHTML = ''; return; }
  const matches = window._allUsers.filter(function (u) {
    return u.name.toLowerCase().indexOf(q) !== -1;
  }).slice(0, 5);
  box.innerHTML = matches.map(function (u) {
    return '<button onclick="pickSuggested(\'' + u.user_id + '\', ' + j(u.name) + ')">' + u.name + '</button>';
  }).join('');
}

function pickSuggested(userId, name) {
  useExisting({ user_id: userId, name: name });
}

function confirmName() {
  const typed = document.getElementById('nameBox').value.trim();
  if (!typed) return;
  render('<div class="card"><div class="spinner"></div></div>');
  rpc('find_user_by_name', { p_name: typed })
    .then(function (matches) {
      if (matches.length === 0) {
        createAndProceed(typed);
      } else {
        showIsThisYou(typed, matches[0]);
      }
    })
    .catch(renderError);
}

function showIsThisYou(typed, match) {
  render(
    '<div class="card">' +
    '<h1>מצאנו את "' + match.name + '"</h1>' +
    '<p class="muted">כבר קיים משתמש בשם הזה. זה אתה?</p>' +
    '<button class="primary" onclick="useExisting(' + j(match) + ')">כן, זה אני</button>' +
    '<button class="secondary" onclick="showDisambiguate(' + j(typed) + ')">לא, זה מישהו אחר</button>' +
    '</div>'
  );
}

function useExisting(match) {
  const user = { user_id: match.user_id, name: match.name };
  setStoredUser(user);
  loadKeyState(user);
}

function showDisambiguate(typed) {
  render(
    '<div class="card">' +
    '<h1>נבדיל ביניכם</h1>' +
    '<p class="muted">הוסף פרט מזהה לשם, למשל מקצוע או שם משפחה נוסף</p>' +
    '<input type="text" id="disambigBox" value="' + typed + ' — ">' +
    '<button class="primary" onclick="submitDisambiguated()">המשך</button>' +
    '</div>'
  );
  const box = document.getElementById('disambigBox');
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function submitDisambiguated() {
  const typed = document.getElementById('disambigBox').value.trim();
  if (!typed) return;
  render('<div class="card"><div class="spinner"></div></div>');
  rpc('find_user_by_name', { p_name: typed })
    .then(function (matches) {
      if (matches.length === 0) {
        createAndProceed(typed);
      } else {
        // still a collision — loop back to the same confirm/disambiguate flow
        showIsThisYou(typed, matches[0]);
      }
    })
    .catch(renderError);
}

function createAndProceed(name) {
  render('<div class="card"><div class="spinner"></div></div>');
  rpc('create_unique_user', { p_name: name })
    .then(function (result) {
      const user = { user_id: result.user_id, name: result.name };
      setStoredUser(user);
      loadKeyState(user);
    })
    .catch(function (err) {
      // Someone else claimed this exact name in the split second between
      // our check and our write — just re-run the lookup and ask again.
      if (String(err.message || err).indexOf('DUPLICATE') !== -1) {
        confirmNameFor(name);
      } else {
        renderError(err);
      }
    });
}

function confirmNameFor(name) {
  rpc('find_user_by_name', { p_name: name }).then(function (matches) {
    if (matches.length > 0) showIsThisYou(name, matches[0]);
    else createAndProceed(name);
  });
}

// ---------- main key state ----------
function loadKeyState(user) {
  render('<div class="card"><h1>' + KEY_ID + '</h1><div class="spinner"></div></div>');
  rpc('get_key_state', { p_key_id: KEY_ID })
    .then(function (state) { renderKeyState(state, user); })
    .catch(renderError);
}

function renderError() {
  render(
    '<div class="card">' +
    '<h1>שגיאה</h1>' +
    '<p>לא הצלחנו לטעון את המפתח. לחץ לנסות שוב.</p>' +
    '<button class="primary" onclick="boot()">נסה שוב</button>' +
    '</div>'
  );
}

function renderKeyState(state, user) {
  if (!state.found) {
    render(
      '<div class="card">' +
      '<h1>תג לא רשום</h1>' +
      '<p>המפתח <b>' + KEY_ID + '</b> עדיין לא רשום במערכת. פנה למנהל.</p>' +
      '</div>'
    );
    return;
  }

  let body = '<div class="card"><h1>' + state.name + '</h1>';
  if (state.location) body += '<p class="muted">' + state.location + '</p>';

  if (state.status === 'in') {
    body += '<span class="status-badge status-in">זמין</span>';
    body += '<button class="primary" onclick="doAction(\'out\',\'auto\')">קח את המפתח</button>';
  } else if (state.holder_id === user.user_id) {
    body += '<span class="status-badge status-out">אצלך מזה ' + timeAgo(state.last_updated) + '</span>';
    body += '<button class="primary return" onclick="doAction(\'in\',\'auto\')">החזר את המפתח</button>';
  } else {
    body += '<span class="status-badge status-warn">⚠️ רשום אצל ' + state.holder_name + ' מזה ' + timeAgo(state.last_updated) + '</span>';
    body += '<button class="primary return" onclick="doAction(\'in\',\'manual\',' + j('הוחזר במקום ' + state.holder_name) + ')">החזר בשביל ' + state.holder_name + '</button>';
    body += '<button class="secondary" onclick="doSwap(' + j(state.holder_id) + ',' + j(state.holder_name) + ')">קח את זה — אצלי עכשיו</button>';
  }

  body += '</div>';
  body += '<div class="link-row">';
  body += '<span class="link" onclick="switchUser()">לא ' + user.name + '? החלף משתמש</span>';
  body += '</div>';

  render(body);
  window._currentState = state;
  window._currentUser = user;
}

function switchUser() {
  clearStoredUser();
  showNamePicker();
}

function doAction(action, method, note) {
  const user = window._currentUser;
  render('<div class="card"><div class="spinner"></div></div>');
  rpc('record_action', {
    p_key_id: KEY_ID,
    p_user_id: user.user_id,
    p_user_name: user.name,
    p_action: action,
    p_method: method || 'auto',
    p_note: note || '',
  })
    .then(function (newState) { renderSuccess(newState, action, user); })
    .catch(renderError);
}

function doSwap(fromUserId, fromUserName) {
  const user = window._currentUser;
  render('<div class="card"><div class="spinner"></div></div>');
  rpc('record_swap', {
    p_key_id: KEY_ID,
    p_from_user_id: fromUserId,
    p_from_user_name: fromUserName,
    p_to_user_id: user.user_id,
    p_to_user_name: user.name,
  })
    .then(function (newState) { renderSuccess(newState, 'out', user); })
    .catch(renderError);
}

function renderSuccess(state, action, user) {
  const msg = action === 'out' ? 'המפתח נרשם על שמך ✔' : 'המפתח הוחזר ✔';
  render(
    '<div class="success-banner">' + msg + '</div>' +
    '<div class="card"><h1>' + state.name + '</h1>' +
    '<span class="status-badge ' + (state.status === 'in' ? 'status-in' : 'status-out') + '">' +
    (state.status === 'in' ? 'זמין' : 'אצל ' + (state.holder_name || user.name)) +
    '</span></div>' +
    '<div class="link-row"><span class="link" onclick="loadKeyState(window._currentUser)">רענן</span></div>'
  );
}

boot();
