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

function loadBoard() {
  rpc('get_board').then(renderBoard);
}

function renderBoard(board) {
  document.getElementById('updated').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL');
  if (!board.length) {
    document.getElementById('board').innerHTML = '<p class="muted">אין מפתחות רשומים.</p>';
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

loadBoard();
setInterval(loadBoard, 30000); // auto-refresh, useful if left open on a wall tablet
