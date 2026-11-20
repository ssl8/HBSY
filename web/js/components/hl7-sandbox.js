/**
 * HL7 v2.5.1 ORU^R01 Sandbox & LIS Inbox viewer.
 * Embedded in Clinical (admin/lab) and Integrations (admin/integration).
 */

import { api } from '../api.js';
import { $, badge, dateTime, empty, esc, table, toast } from '../dom.js';
import { state } from '../state.js';

let lastControlId = 'MSG-20261113-1001';
let lastRawSample = '';

function formatHl7Timestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function findTargetLabOrder() {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  return (
    orders.find(o => o.orderType === 'LAB' && o.status === 'InProgress') ||
    orders.find(o => o.orderType === 'LAB' && o.status === 'Submitted') ||
    orders.find(o => o.orderType === 'LAB' && o.status === 'Created') ||
    orders.find(o => o.orderType === 'LAB') ||
    { id: 1, mrn: 'HB-000101', code: '718-7', description: 'Tam Kan Sayımı / Hemogram' }
  );
}

export function buildSampleHl7(kind = 'cbc', reuseControlId = false) {
  const ord = findTargetLabOrder();
  const ts = formatHl7Timestamp();
  const ctrl = reuseControlId && lastControlId
    ? lastControlId
    : `MSG-${ts}-${Math.floor(100 + Math.random() * 900)}`;
  lastControlId = ctrl;

  const mrn = ord.mrn || 'HB-000101';
  const orderId = ord.id || 1;
  const orderCode = ord.code || '718-7';
  const orderDesc = ord.description || 'Hemogram / Biyokimya';

  let sample;
  if (kind === 'critical') {
    sample = [
      `MSH|^~\\&|COBAS-E411|LAB|NOVA-HBYS|HOSPITAL|${ts}||ORU^R01|${ctrl}|P|2.5.1`,
      `PID|1||${mrn}^^^HBYS^MR||SAHIN^MUSTAFA||19670228|M`,
      `OBR|1|ORD-${orderId}|${orderId}|${orderCode}^${orderDesc}^LN|||${ts}`,
      `OBX|1|NM|10839-9^Kardiyak Troponin I (hs-cTnI)||2.45|ng/mL|0.00 - 0.04|HH|||F`,
      `OBX|2|NM|2160-0^Serum Kreatinin||1.18|mg/dL|0.70 - 1.20|N|||F`
    ].join('\n');
  } else {
    sample = [
      `MSH|^~\\&|SYSMEX-XN1000|LAB|NOVA-HBYS|HOSPITAL|${ts}||ORU^R01|${ctrl}|P|2.5.1`,
      `PID|1||${mrn}^^^HBYS^MR||KOC^BURAK||19791203|M`,
      `OBR|1|ORD-${orderId}|${orderId}|${orderCode}^${orderDesc}^LN|||${ts}`,
      `OBX|1|NM|718-7^Hemoglobin (HGB)||14.1|g/dL|12.0 - 16.0|N|||F`,
      `OBX|2|NM|6690-2^Lokosit (WBC)||7.8|10^3/uL|4.0 - 10.5|N|||F`,
      `OBX|3|NM|777-3^Trombosit (PLT)||242|10^3/uL|150 - 450|N|||F`
    ].join('\n');
  }

  lastRawSample = sample;
  return sample;
}

export async function renderHl7SandboxMarkup() {
  let inbox = [];
  let inboxErr = null;
  try {
    inbox = await api('/api/lis/inbox');
    state.lisInbox = Array.isArray(inbox) ? inbox : [];
  } catch (err) {
    inboxErr = err.message;
  }

  const initialMsg = lastRawSample || buildSampleHl7('cbc', false);
  const rows = (state.lisInbox || []).map(m => `<tr>
    <td><span class="primary-cell">${esc(m.messageControlId || '—')}</span><span class="sub-cell">#${esc(m.id)}</span></td>
    <td>${esc(m.sourceSystem || 'HL7')}</td>
    <td>${badge(m.status)}</td>
    <td>${dateTime(m.receivedAt)}</td>
    <td>${dateTime(m.processedAt)}</td>
    <td><span class="sub-cell">${esc(m.lastError || '—')}</span></td>
  </tr>`).join('');

  return `
    <div class="grid two-col">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>HL7 v2.5.1 ORU^R01 Mesaj Editörü</h3>
            <p>Cihaz otoanalizör verisi gönderimi ve MSH-10 idempotency doğrulaması</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="hl7-sample-bar">
            <button class="btn btn-light btn-sm" type="button" data-hl7-sample="cbc">🧪 Normal CBC Üret</button>
            <button class="btn btn-danger btn-sm" type="button" data-hl7-sample="critical">🚨 Kritik Troponin Üret</button>
            <button class="btn btn-amber btn-sm" type="button" data-hl7-sample="replay">♻ Tekrarlı MSH-10 (Replay)</button>
          </div>
          <form id="hl7-sandbox-form">
            <div class="field full">
              <label for="hl7-source-system">Kaynak Cihaz / Sistem (MSH-3)</label>
              <input id="hl7-source-system" name="sourceSystem" value="LIS-SANDBOX" maxlength="80">
            </div>
            <div class="field full">
              <label for="hl7-raw-message">Ham HL7 v2.5.1 ORU^R01 Mesajı</label>
              <textarea id="hl7-raw-message" name="rawMessage" class="hl7-textarea" rows="8" required>${esc(initialMsg)}</textarea>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">HL7 ORU^R01 Gönder (POST /api/hl7/oru)</button>
            </div>
          </form>
          <div id="hl7-ack-output" class="hl7-ack-box hidden"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>LIS Gelen Kutusu (${state.lisInbox.length})</h3>
            <p>GET /api/lis/inbox · MSH-10 mesaj kontrol izleme</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-action="refresh-hl7-inbox">↻ Yenile</button>
        </div>
        ${inboxErr
          ? `<div class="panel-body"><div class="notice">${esc(inboxErr)}</div></div>`
          : state.lisInbox.length
            ? table(['MSH-10 KONTROL ID', 'KAYNAK', 'DURUM', 'ALINDI', 'İŞLENDİ', 'HATA / NOT'], rows)
            : empty('LIS gelen kutusunda kayıt yok')}
      </section>
    </div>
  `;
}

export function bindHl7SandboxEvents(container, onAfterIngest) {
  if (!container) return;

  container.querySelectorAll('[data-action="refresh-hl7-inbox"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        if (typeof onAfterIngest === 'function') {
          await onAfterIngest();
        } else {
          const inbox = await api('/api/lis/inbox');
          state.lisInbox = Array.isArray(inbox) ? inbox : [];
        }
        toast('LIS gelen kutusu güncellendi.', 'success');
      } catch (err) {
        toast(err?.message || 'LIS gelen kutusu yenilenemedi.', 'error');
      }
    });
  });

  container.querySelectorAll('[data-hl7-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.hl7Sample;
      const textarea = $('#hl7-raw-message');
      if (!textarea) return;
      if (kind === 'replay') {
        if (lastRawSample) {
          textarea.value = lastRawSample;
          toast(`Son MSH-10 (${lastControlId}) tekrar gönderime hazırlandı.`, 'success');
        } else {
          textarea.value = buildSampleHl7('cbc', true);
        }
      } else {
        textarea.value = buildSampleHl7(kind, false);
      }
    });
  });

  const form = $('#hl7-sandbox-form');
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const rawMessage = String($('#hl7-raw-message')?.value || '').trim();
    const sourceSystem = String($('#hl7-source-system')?.value || 'LIS-SANDBOX').trim();
    const ackBox = $('#hl7-ack-output');

    if (!rawMessage) {
      toast('HL7 mesajı boş olamaz.', 'error');
      return;
    }

    lastRawSample = rawMessage;
    const mshLine = rawMessage.split(/\r?\n/).find(l => l.startsWith('MSH'));
    if (mshLine) {
      const sep = mshLine[3] || '|';
      const ctrl = mshLine.split(sep)[9];
      if (ctrl) lastControlId = ctrl;
    }

    try {
      const res = await api('/api/hl7/oru', {
        method: 'POST',
        body: { rawMessage, sourceSystem }
      });

      const isDup = Boolean(res.deduplicated || res.duplicate);
      const statusText = res.status || (isDup ? 'DuplicateIgnored' : 'Processed');
      if (ackBox) {
        ackBox.classList.remove('hidden');
        ackBox.innerHTML = `
          <div class="hl7-ack-head">
            <strong>HL7 Yanıtı (ACK)</strong>
            ${badge(statusText)}
          </div>
          <pre class="hl7-ack-pre">${esc(res.ack || JSON.stringify(res, null, 2))}</pre>
          ${res.error ? `<div class="form-error">${esc(res.error)}</div>` : ''}
        `;
      }

      if (isDup) {
        toast(`Tekrarlı MSH-10 (${res.controlId || lastControlId}) reddedildi: DuplicateIgnored.`, 'success');
      } else if (res.error) {
        toast(`HL7 uyarısı: ${res.error}`, 'error');
      } else {
        toast(`HL7 ORU^R01 işlendi (${res.observationCount ?? ''} gözlem).`, 'success');
      }

      if (typeof onAfterIngest === 'function') {
        await onAfterIngest();
      }
    } catch (err) {
      if (ackBox) {
        ackBox.classList.remove('hidden');
        ackBox.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      }
      toast(err.message, 'error');
    }
  });
}
