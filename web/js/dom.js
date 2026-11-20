/**
 * DOM utilities, XSS-safe escaping, formatters, badges, and modal helpers.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** Escape untrusted text before inserting into HTML strings. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESC_MAP[ch]);
}

/** Display a transient toast notification using textContent only (XSS-safe). */
export function toast(message, kind = 'success') {
  const region = $('#toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = String(message ?? '');
  region.append(el);
  setTimeout(() => el.remove(), 4500);
}

export function dateOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('tr-TR');
}

export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('tr-TR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function currency(value, curr = 'TRY') {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('tr-TR', { style: 'currency', currency: curr || 'TRY' });
}

export function initials(name) {
  return (name || 'HB')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase() || 'HB';
}

const BADGE_GREEN = new Set([
  'Open', 'Available', 'Paid', 'Dispensed', 'Sent', 'Verified',
  'Onaylandı', 'Online', 'ONLINE', 'Arrived', 'Processed', 'LOW', 'Normal'
]);
const BADGE_BLUE = new Set([
  'Admitted', 'InProgress', 'Pending', 'Created', 'Resulted',
  'Booked', 'InHospital', 'Receipt', 'DuplicateIgnored', 'LOW_MEDIUM'
]);
const BADGE_AMBER = new Set([
  'Issued', 'Submitted', 'Occupied', 'Cleaning', 'EnRoute',
  'Triaged', 'MEDIUM', 'Retrying', 'YELLOW'
]);
const BADGE_RED = new Set([
  'Failed', 'Rejected', 'Cancelled', 'Discharged', 'RED',
  'HIGH', 'DeadLetter', 'Dispense', 'DISPENSE'
]);

const STATUS_LABELS = {
  Open: 'Açık',
  Admitted: 'Yatışta / Kabul',
  Discharged: 'Taburcu',
  Available: 'Uygun',
  Occupied: 'Dolu',
  Cleaning: 'Temizlikte',
  Created: 'Oluşturuldu',
  Submitted: 'Gönderildi',
  InProgress: 'İşlemde',
  Resulted: 'Sonuçlandı',
  Verified: 'Onaylandı',
  Cancelled: 'İptal',
  Rejected: 'Reddedildi',
  Pending: 'Bekliyor',
  Dispensed: 'Karşılandı',
  Issued: 'Düzenlendi',
  Paid: 'Ödendi',
  Sent: 'Gönderildi',
  Failed: 'Hata',
  DeadLetter: 'Ölü Kuyruk',
  Retrying: 'Yeniden Deneniyor',
  Booked: 'Randevu Alındı',
  Arrived: 'Geldi',
  InHospital: 'Hastanede',
  EnRoute: 'Yolda (112)',
  Triaged: 'Triyajda',
  Processed: 'İşlendi',
  DuplicateIgnored: 'Tekrar Reddedildi (MSH-10)',
  LOW: 'Düşük Risk',
  LOW_MEDIUM: 'Düşük-Orta Risk',
  MEDIUM: 'Orta Risk',
  HIGH: 'Yüksek Risk'
};

export function badge(status) {
  const raw = String(status ?? '—');
  let color = 'gray';
  if (BADGE_GREEN.has(raw)) color = 'green';
  else if (BADGE_BLUE.has(raw)) color = 'blue';
  else if (BADGE_AMBER.has(raw)) color = 'amber';
  else if (BADGE_RED.has(raw)) color = 'red';
  return `<span class="badge ${color}">${esc(STATUS_LABELS[raw] || raw)}</span>`;
}

export function heading(kicker, title, subtitle, actionsHtml = '') {
  return `<div class="page-heading">
    <div>
      <div class="section-kicker">${esc(kicker)}</div>
      <h1>${esc(title)}</h1>
      <p>${esc(subtitle)}</p>
    </div>
    <div class="heading-actions">${actionsHtml}</div>
  </div>`;
}

export function empty(title, sub = 'Henüz kayıt bulunmuyor.') {
  return `<div class="empty-state"><strong>${esc(title)}</strong>${esc(sub)}</div>`;
}

export function table(headers, rowsHtml) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml || ''}</tbody></table></div>`;
}

export function showModal(title, bodyHtml, eyebrow = 'YENİ İŞLEM', isWide = false) {
  const modal = $('#modal');
  if (!modal) return;
  const eb = $('#modal-eyebrow');
  const mt = $('#modal-title');
  const mb = $('#modal-body');
  if (eb) eb.textContent = String(eyebrow ?? '');
  if (mt) mt.textContent = String(title ?? '');
  if (mb) mb.innerHTML = bodyHtml;
  const card = $('#modal .modal-card');
  if (card) card.classList.toggle('modal-wide', Boolean(isWide));
  if (!modal.open && typeof modal.showModal === 'function') modal.showModal();
}

export function closeModal() {
  const modal = $('#modal');
  if (modal?.open) modal.close();
  const mb = $('#modal-body');
  if (mb) mb.innerHTML = '';
}

export function formActions(label = 'Kaydet') {
  return `<div class="form-actions">
    <button class="btn btn-ghost" type="button" data-close>Vazgeç</button>
    <button class="btn btn-primary" type="submit">${esc(label)}</button>
  </div>`;
}

/** Read a field safely supporting canonical camelCase and legacy snake_case keys. */
export function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** Format canonical patient display name from patientName or givenName + familyName. */
export function patientDisplayName(row) {
  if (!row) return '—';
  if (row.patientName) return String(row.patientName);
  const full = `${row.givenName || ''} ${row.familyName || ''}`.trim();
  if (full) return full;
  if (row.patientId) return `Hasta #${row.patientId}`;
  if (row.encounterId) return `Karşılaşma #${row.encounterId}`;
  if (row.orderId) return `İstem #${row.orderId}`;
  return '—';
}
