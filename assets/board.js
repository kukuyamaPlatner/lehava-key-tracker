// Board screen (no params) — public, read-only, auto-refreshes every 30s.
document.getElementById('adminLink').href = 'admin.html';

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return mins + ' ד׳';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' שע׳';
  const days = Math.round(hrs / 24);
  return days + ' ימים';
}

let _lastBoard = [];

function loadBoard() {
  rpc('get_board').then(function (board) {
    _lastBoard = board;
    document.getElementById('updated').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL');
    renderBoard();
  });
}

function renderBoard() {
  const q = document.getElementById('boardSearch').value.trim().toLowerCase();
  const board = !q ? _lastBoard : _lastBoard.filter(function (k) {
    return (k.name || '').toLowerCase().indexOf(q) !== -1 ||
      (k.location || '').toLowerCase().indexOf(q) !== -1;
  });

  if (!_lastBoard.length) {
    document.getElementById('board').innerHTML = '<p class="muted">אין מפתחות רשומים.</p>';
    return;
  }
  if (!board.length) {
    document.getElementById('board').innerHTML = '<p class="muted">לא נמצאו מפתחות מתאימים.</p>';
    return;
  }

  let html = '<table><tr><th>מפתח</th><th>מיקום</th><th>סטטוס</th><th>אצל</th><th>מזה</th></tr>';
  board.forEach(function (k) {
    const badge = k.status === 'in'
      ? '<span class="status-badge status-in">זמין</span>'
      : '<span class="status-badge status-out">בחוץ</span>';
    html += '<tr><td>' + k.name + '</td><td>' + (k.location || '') + '</td><td>' + badge + '</td>' +
      '<td>' + (k.holder_name || '—') + '</td><td>' + (k.status === 'out' ? timeAgo(k.last_updated) : '—') + '</td></tr>';
  });
  html += '</table>';
  document.getElementById('board').innerHTML = html;
}

document.getElementById('boardSearch').addEventListener('input', renderBoard);

loadBoard();
setInterval(loadBoard, 30000); // auto-refresh, useful if left open on a wall tablet
