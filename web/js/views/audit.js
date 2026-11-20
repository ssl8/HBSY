import { api } from '../api.js';
import {
  badge,
  dateTime,
  empty,
  esc,
  heading,
  table,
} from '../dom.js';

function shortHash(hash) {
  const s = String(hash || '');
  if (!s) return '-';
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

export async function renderAudit() {
  const data = await api('/api/audit');
  const events = Array.isArray(data?.events) ? data.events : (Array.isArray(data) ? data : []);
  const chainValid = data?.chainValid !== false;
  const verifiedCount = Number(data?.verifiedCount ?? events.length);
  const brokenEventId = data?.brokenEventId ?? null;

  const chainBanner = chainValid
    ? `
      <div class="alert-banner alert-success">
        <div>
          <strong>✔ SHA-256 Hash Zinciri Doğrulandı</strong>
          <span>Toplam ${esc(verifiedCount)} denetim olayı kriptografik olarak tutarlı (tamper-evident log).</span>
        </div>
        <span class="badge badge-success">ZİNCİR SAĞLAM (${esc(verifiedCount)}/${esc(events.length)})</span>
      </div>
    `
    : `
      <div class="alert-banner alert-danger">
        <div>
          <strong>⚠ SHA-256 Hash Zinciri Bütünlük Hatası!</strong>
          <span>Kırılan olay kimliği: #${esc(brokenEventId ?? '?')} · Kurcalama veya eksik kayıt tespit edildi.</span>
        </div>
        <span class="badge badge-danger">ZİNCİR KIRIK</span>
      </div>
    `;

  const rows = events.map((ev) => {
    const isBroken = brokenEventId && String(ev.id) === String(brokenEventId);
    const actorName = ev.username || ev.actor || '-';
    const actorRole = ev.role || ev.actorRole || '';
    return `
      <tr class="${isBroken ? 'row-critical-alert' : ''}">
        <td><strong>#${esc(ev.id)}</strong></td>
        <td>${esc(dateTime(ev.occurredAt || ev.createdAt))}</td>
        <td>
          <div class="cell-strong">${esc(actorName)}</div>
          ${actorRole ? `<div class="table-sub">${esc(actorRole)}</div>` : ''}
        </td>
        <td><code>${esc(ev.action || '-')}</code></td>
        <td>${badge(ev.entityType || '-')} #${esc(ev.entityId ?? '-')}</td>
        <td><code title="${esc(ev.previousHash || '')}">${esc(shortHash(ev.previousHash))}</code></td>
        <td><code title="${esc(ev.eventHash || '')}">${esc(shortHash(ev.eventHash))}</code></td>
      </tr>
    `;
  }).join('');

  return `
    ${heading('KVKK & GÜVENLİK DENETİMİ', 'Denetim İzleri & Hash Zinciri', 'Değiştirilemez SHA-256 hash zincirli kurumsal erişim ve klinik işlem kayıtları')}

    ${chainBanner}

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Denetim Olay Günlüğü</h2>
          <p class="panel-sub">Her kayıt bir önceki olayın SHA-256 özeti (previousHash) ile zincirlenir</p>
        </div>
      </div>
      ${events.length
        ? table(['ID', 'Zaman', 'Aktör / Rol', 'Eylem', 'Varlık', 'Önceki Hash', 'Olay Hash'], rows)
        : empty('Denetim kaydı bulunmuyor.')}
    </section>
  `;
}

export function bindAuditEvents() {
  // Read-only audit ledger
}
