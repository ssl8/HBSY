import { api } from '../api.js';
import {
  badge,
  dateTime,
  empty,
  esc,
  heading,
  table,
  toast,
} from '../dom.js';
import { bindHl7SandboxEvents, renderHl7SandboxMarkup } from '../components/hl7-sandbox.js';

export async function renderIntegrations() {
  const [outboxList, hl7Html] = await Promise.all([
    api('/api/integrations'),
    renderHl7SandboxMarkup(),
  ]);

  const rows = (Array.isArray(outboxList) ? outboxList : []).map((row) => {
    const canRetry = row.status !== 'Sent';
    return `
      <tr>
        <td><strong>#${esc(row.id)}</strong></td>
        <td>${esc(row.target || '-')}</td>
        <td><code>${esc(row.eventType || '-')}</code></td>
        <td>${esc(row.aggregateType || '-')} #${esc(row.aggregateId ?? '-')}</td>
        <td>${badge(row.status || 'Pending')}</td>
        <td>${esc(row.attempts ?? 0)}</td>
        <td>${esc(dateTime(row.createdAt))}</td>
        <td>${esc(dateTime(row.nextAttemptAt))}</td>
        <td>${row.lastError ? `<span class="text-danger">${esc(row.lastError)}</span>` : '<span class="muted">-</span>'}</td>
        <td>
          ${canRetry ? `<button type="button" class="btn btn-sm btn-primary" data-retry-outbox="${esc(row.id)}">Yeniden Dene</button>` : '<span class="muted">Tamamlandı</span>'}
        </td>
      </tr>
    `;
  }).join('');

  return `
    ${heading('ENTEGRASYON & OUTBOX', 'Entegrasyonlar', 'Outbox / entegrasyon kayıtları ve HL7 v2.5.1 ORU^R01 mesaj işleme kuyruğu')}

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Outbox / entegrasyon kayıtları</h2>
          <p class="panel-sub">KVKK veri minimizasyonu uyarınca yalnızca olay üstverileri görüntülenir (ham payload gizlidir)</p>
        </div>
      </div>
      ${rows
        ? table(['ID', 'Hedef Sistem', 'Olay Türü', 'Kayıt Ref', 'Durum', 'Deneme', 'Oluşturulma', 'Sonraki Deneme', 'Son Hata', 'İşlem'], rows)
        : empty('Outbox kaydı bulunmuyor.')}
    </section>

    ${hl7Html}
  `;
}

export function bindIntegrationsEvents(container, { reload }) {
  if (!container) return;

  bindHl7SandboxEvents(container, reload);

  container.addEventListener('click', async (e) => {
    const retryBtn = e.target.closest('[data-retry-outbox]');
    if (!retryBtn) return;
    const id = retryBtn.dataset.retryOutbox;
    try {
      await api(`/api/integrations/${id}/retry`, { method: 'POST' });
      toast(`Outbox kaydı #${id} yeniden kuyruğa alındı.`);
      await reload();
    } catch (err) {
      toast(err?.message || 'Yeniden deneme başarısız.', 'error');
    }
  });
}
