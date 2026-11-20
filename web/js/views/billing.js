import { api } from '../api.js';
import {
  $,
  $$,
  badge,
  closeModal,
  currency,
  dateTime,
  empty,
  esc,
  formActions,
  heading,
  patientDisplayName,
  showModal,
  table,
  toast,
} from '../dom.js';
import { hasRole } from '../state.js';

let cachedEncounters = [];
let cachedInvoices = [];

function invoiceLineHtml(line = {}) {
  const code = line.code || '520.010';
  const desc = line.description || '';
  const qty = Number(line.qty ?? line.quantity ?? 1);
  const unitPrice = Number(line.unitPrice ?? 250);
  const lineTotal = (qty * unitPrice).toFixed(2);

  return `
    <tr class="sut-line-row">
      <td><input name="code" class="sut-input-sm" required value="${esc(code)}" /></td>
      <td><input name="description" class="sut-input-wide" required value="${esc(desc)}" placeholder="SUT Hizmet Açıklaması" /></td>
      <td><input type="number" name="qty" class="sut-qty sut-input-num" required min="0.01" step="0.01" value="${esc(qty)}" /></td>
      <td><input type="number" name="unitPrice" class="sut-price sut-input-num" required min="0.01" step="0.01" value="${esc(unitPrice)}" /></td>
      <td class="sut-line-total"><strong>${esc(lineTotal)} TRY</strong></td>
      <td><button type="button" class="btn btn-sm btn-ghost sut-remove-row" title="Satırı Sil">✕</button></td>
    </tr>
  `;
}

function recomputeInvoicePreviewTotals(container) {
  let grandTotal = 0;
  $$('.sut-line-row', container).forEach((row) => {
    const qty = Number(row.querySelector('.sut-qty')?.value || 0);
    const price = Number(row.querySelector('.sut-price')?.value || 0);
    const sub = Math.max(0, qty * price);
    grandTotal += sub;
    const cell = row.querySelector('.sut-line-total');
    if (cell) cell.innerHTML = `<strong>${esc(currency(sub))}</strong>`;
  });
  const totalEl = $('#sut-grand-total');
  if (totalEl) totalEl.textContent = currency(grandTotal);
}

function openNewInvoiceModal(onDone) {
  if (!cachedEncounters.length) {
    toast('Faturalandırılacak karşılaşma bulunamadı.', 'warning');
    return;
  }

  const encOptions = cachedEncounters.map((e) => `
    <option value="${esc(e.id)}">#${esc(e.id)} — ${esc(patientDisplayName(e))} (${esc(e.encounterType)} · ${esc(e.medulaTakipNo || 'Takip Yok')})</option>
  `).join('');

  showModal(
    'Çok Kalemli MEDULA SUT Faturası Oluştur',
    `<form id="form-new-invoice" class="form-grid">
      <label class="field">
        <span>Karşılaşma *</span>
        <select name="encounterId" id="inv-encounter-select" required>${encOptions}</select>
      </label>
      <label class="field">
        <span>Ödeyici Kurum *</span>
        <select name="payer" required>
          <option value="SGK">SGK / MEDULA GSS</option>
          <option value="Özel Sigorta">Özel Sağlık Sigortası (ÖSS / TSS)</option>
          <option value="Ücretli">Hasta Ödemeli (Ücretli)</option>
        </select>
      </label>

      <div class="field field-full">
        <div class="rx-composer-head">
          <span>SUT Hizmet & Reçete Kalemleri</span>
          <div class="inline-actions">
            <button type="button" id="btn-fetch-charge-preview" class="btn btn-sm btn-primary">Karşılaşma Kalemlerini Getir</button>
            <button type="button" id="btn-add-sut-row" class="btn btn-sm btn-ghost">+ Kalem Ekle</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>SUT Kodu</th>
                <th>Açıklama</th>
                <th>Miktar</th>
                <th>Birim (TRY)</th>
                <th>Satır Toplam</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="sut-lines-body">
              ${invoiceLineHtml({ code: '520.010', description: 'Poliklinik Muayene Bedeli', qty: 1, unitPrice: 450 })}
            </tbody>
          </table>
        </div>
        <div class="sut-total-bar">
          <span>Fatura Genel Toplamı:</span>
          <strong id="sut-grand-total">${esc(currency(450))}</strong>
        </div>
      </div>

      ${formActions('Faturayı Kes')}
    </form>`,
    'MEDULA SUT FATURALAMA',
    true,
  );

  const tbody = $('#sut-lines-body');
  recomputeInvoicePreviewTotals(tbody);

  $('#btn-fetch-charge-preview')?.addEventListener('click', async () => {
    const encId = $('#inv-encounter-select')?.value;
    if (!encId) return;
    try {
      const preview = await api(`/api/encounters/${encId}/charge-preview`);
      const lines = Array.isArray(preview?.lines) ? preview.lines : [];
      if (!lines.length) {
        toast('Bu karşılaşmada otomatik aktarılacak hizmet kalemi bulunamadı.', 'warning');
        return;
      }
      if (tbody) {
        tbody.innerHTML = lines.map((l) => invoiceLineHtml(l)).join('');
        recomputeInvoicePreviewTotals(tbody);
      }
      toast(`${lines.length} adet SUT/Eczane kalemi karşılaşmadan yüklendi.`);
    } catch (err) {
      toast(err?.message || 'Karşılaşma kalemleri getirilemedi.', 'error');
    }
  });

  $('#btn-add-sut-row')?.addEventListener('click', () => {
    tbody?.insertAdjacentHTML('beforeend', invoiceLineHtml({ code: '520.020', description: 'Ek Klinik Hizmet', qty: 1, unitPrice: 180 }));
    recomputeInvoicePreviewTotals(tbody);
  });

  tbody?.addEventListener('click', (e) => {
    const rm = e.target.closest('.sut-remove-row');
    if (!rm) return;
    if ($$('.sut-line-row', tbody).length <= 1) {
      toast('Fatura en az bir kalem içermelidir.', 'warning');
      return;
    }
    rm.closest('.sut-line-row')?.remove();
    recomputeInvoicePreviewTotals(tbody);
  });

  tbody?.addEventListener('input', () => recomputeInvoicePreviewTotals(tbody));

  $('#form-new-invoice')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const encounterId = Number($('#inv-encounter-select')?.value);
    const payer = String(e.target.querySelector('[name="payer"]')?.value || 'SGK');
    const lines = $$('.sut-line-row', tbody).map((row) => ({
      code: String(row.querySelector('[name="code"]')?.value || '').trim(),
      description: String(row.querySelector('[name="description"]')?.value || '').trim(),
      qty: Number(row.querySelector('[name="qty"]')?.value || 1),
      unitPrice: Number(row.querySelector('[name="unitPrice"]')?.value || 0),
    }));

    const first = lines[0] || { code: '520.010', description: 'Klinik Hizmet', qty: 1, unitPrice: 100 };

    try {
      await api('/api/invoices', {
        method: 'POST',
        body: {
          encounterId,
          payer,
          lines,
          code: first.code,
          description: first.description,
          quantity: first.qty,
          unitPrice: first.unitPrice,
        },
      });
      closeModal();
      toast('MEDULA SUT faturası oluşturuldu.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Fatura kesilemedi.', 'error');
    }
  });
}

function openInvoiceDetailModal(inv) {
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const rows = lines.map((l) => `
    <tr>
      <td><strong>${esc(l.code || '-')}</strong></td>
      <td>${esc(l.description || '-')}</td>
      <td>${esc(l.qty ?? l.quantity ?? 1)}</td>
      <td>${esc(currency(l.unitPrice))}</td>
      <td><strong>${esc(currency(l.lineTotal ?? ((l.qty ?? 1) * (l.unitPrice ?? 0))))}</strong></td>
    </tr>
  `).join('');

  showModal(
    `Fatura Detayı — ${inv.invoiceNo || `#${inv.id}`}`,
    `
      <div class="detail-kv-row">
        <span><strong>Hasta:</strong> ${esc(patientDisplayName(inv))}</span>
        <span><strong>Kurum:</strong> ${esc(inv.payer || '-')}</span>
        <span><strong>Durum:</strong> ${badge(inv.status || 'Draft')}</span>
      </div>
      ${rows
        ? table(['SUT Kodu', 'Hizmet Açıklaması', 'Miktar', 'Birim Fiyat', 'Satır Toplamı'], rows)
        : empty('Fatura kalemi detayı bulunamadı.')}
      <div class="sut-total-bar">
        <span>Toplam Tutar:</span>
        <strong>${esc(currency(inv.total ?? inv.totalAmount ?? 0))}</strong>
      </div>
    `,
    'SUT FATURA DETAYI',
    true,
  );
}

export async function renderBilling() {
  const canBill = hasRole('admin', 'billing');
  const [invoices, encounters] = await Promise.all([
    api('/api/invoices'),
    canBill ? api('/api/encounters').catch(() => []) : Promise.resolve([]),
  ]);

  cachedInvoices = Array.isArray(invoices) ? invoices : [];
  cachedEncounters = Array.isArray(encounters) ? encounters : [];

  const totalRevenue = cachedInvoices.reduce((acc, inv) => acc + Number(inv.total ?? inv.totalAmount ?? 0), 0);
  const paidRevenue = cachedInvoices
    .filter((i) => i.status === 'Paid')
    .reduce((acc, inv) => acc + Number(inv.total ?? inv.totalAmount ?? 0), 0);

  const rows = cachedInvoices.map((inv) => {
    const fullName = patientDisplayName(inv);
    const total = Number(inv.total ?? inv.totalAmount ?? 0);
    const lineCount = Array.isArray(inv.lines) ? inv.lines.length : (inv.lineCount ?? 1);
    const payBtn = canBill && inv.status !== 'Paid'
      ? `<button type="button" class="btn btn-sm btn-success" data-pay-invoice="${esc(inv.id)}">Tahsil Et</button>`
      : '';

    return `
      <tr>
        <td><strong>${esc(inv.invoiceNo || `INV-${inv.id}`)}</strong></td>
        <td>
          <div class="cell-strong">${esc(fullName)}</div>
          <div class="table-sub">${esc(inv.mrn || '')}</div>
        </td>
        <td>${esc(inv.payer || 'SGK')}</td>
        <td>${esc(lineCount)} kalem</td>
        <td><strong>${esc(currency(total, inv.currency || 'TRY'))}</strong></td>
        <td>${badge(inv.status || 'Issued')}</td>
        <td>${esc(dateTime(inv.createdAt))}</td>
        <td class="table-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-view-invoice="${esc(inv.id)}">Kalemler</button>
          ${payBtn}
        </td>
      </tr>
    `;
  }).join('');

  const actions = canBill
    ? '<button type="button" id="btn-new-invoice" class="btn btn-primary btn-sm">+ Yeni SUT Fatura</button>'
    : '';

  return `
    ${heading('GELİR DÖNGÜSÜ & SGK', 'Faturalama & MEDULA SUT', 'Otomatik karşılaşma kalemi aktarımı, çok kalemli SUT faturalama ve tahsilat', actions)}

    <section class="kpi-grid kpi-grid-compact">
      <article class="kpi-card">
        <span class="kpi-label">Toplam Fatura</span>
        <strong class="kpi-value">${esc(cachedInvoices.length)}</strong>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Tahakkuk Eden Toplam</span>
        <strong class="kpi-value">${esc(currency(totalRevenue))}</strong>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Tahsil Edilen</span>
        <strong class="kpi-value text-success">${esc(currency(paidRevenue))}</strong>
      </article>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Fatura Listesi</h2>
          <p class="panel-sub">Karşılaşma kalemlerini otomatik getirmek için Yeni SUT Fatura ekranını kullanın</p>
        </div>
      </div>
      ${cachedInvoices.length
        ? table(['Fatura No', 'Hasta', 'Ödeyici', 'Kalem', 'Toplam Tutar', 'Durum', 'Tarih', 'İşlemler'], rows)
        : empty('Kayıtlı fatura bulunmuyor.')}
    </section>
  `;
}

export function bindBillingEvents(container, { reload }) {
  if (!container) return;

  container.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-new-invoice')) {
      openNewInvoiceModal(reload);
      return;
    }

    const viewBtn = e.target.closest('[data-view-invoice]');
    if (viewBtn) {
      const inv = cachedInvoices.find((i) => String(i.id) === String(viewBtn.dataset.viewInvoice));
      if (inv) openInvoiceDetailModal(inv);
      return;
    }

    const payBtn = e.target.closest('[data-pay-invoice]');
    if (payBtn) {
      const id = payBtn.dataset.payInvoice;
      try {
        await api(`/api/invoices/${id}/pay`, { method: 'POST' });
        toast(`Fatura #${id} tahsil edildi olarak işaretlendi.`);
        await reload();
      } catch (err) {
        toast(err?.message || 'Tahsilat kaydedilemedi.', 'error');
      }
    }
  });
}
