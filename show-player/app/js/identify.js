// Fills in the "which screen is this" card from the address.
const q = new URLSearchParams(location.search);
document.getElementById('n').textContent = q.get('n') || '?';
document.getElementById('l').textContent = q.get('label') || '';
document.getElementById('s').textContent = (q.get('size') || '') + (q.get('main') ? ' · main screen (controls)' : '');
