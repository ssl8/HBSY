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
import { showAllergyConflictModal } from '../components/allergy-modal.js';

let cachedDrugs = [];
let cachedEncounters = [];
let cachedPrescriptions = [];

function renderDrugOptions(selectedId) {
  return cachedDrugs
    .filter((d) => d.active !== false)
    .map((d) => {
      const sel = String(d.id) === String(selectedId) ? 'selected' : '';
      const grp = d.allergyGroup ? ` · Grup: ${d.allergyGroup}` : '';
      return `<option value="${esc(d.id)}" ${sel}>${esc(d.name)} (Stok: ${esc(d.stock)}${esc(grp)})</option>`;
    })
    .join('');
}

function createRxRowHtml(rowIdx, defaultDrugId) {
  return `
    <div class="rx-item-row" data-rx-row="${rowIdx}">
      <div class="rx-row-grid">
        <label class="field rx-col-drug">
          <span>İlaç *</span>
          <select name="drugId" class="rx-drug-select" required>${renderDrugOptions(defaultDrugId)}</select>
        </label>
        <label class="field">
          <span>Doz *</span>
          <input name="dosage" required value="1000 mg" placeholder="2x1 / 500 mg" />
        </label>
        <label class="field">
          <span>Sıklık *</span>
          <input name="frequency" required value="12 saatte bir" placeholder="Günde 2" />
        </label>
        <label class="field rx-col-num">
          <span>Gün *</span>
          <input type="number" name="durationDays" required min="1" max="180" value="7" />
        </label>
        <label class="field rx-col-num">
          <span>Adet *</span>
          <input type="number" name="quantity" class="rx-qty-input" required min="1" max="90" value="1" />
        </label>
        <label class="field">
          <span>Kullanım</span>
          <input name="usage" value="Oral / Tok" placeholder="Oral" />
        </label>
        <div class="rx-row-remove">
          <button type="button" class="btn btn-sm btn-ghost rx-remove-btn" title="Satırı Sil">✕</button>
        </div>
      </div>
      <div class="rx-stock-hint"></div>
    </div>
  `;
}

function updateRxStockHints(container) {
  const rows = $$('.rx-item-row', container);
  rows.forEach((row) => {
    const drugId = row.querySelector('.rx-drug-select')?.value;
    const qty = Number(row.querySelector('.rx-qty-input')?.value || 0);
    const hint = row.querySelector('.rx-stock-hint');
    const drug = cachedDrugs.find((d) => String(d.id) === String(drugId));
    if (!hint || !drug) return;

    const warnings = [];
    if (qty > Number(drug.stock ?? 0)) {
      warnings.push(`⚠ Yetersiz stok! Mevcut: ${drug.stock}, İstenen: ${qty}`);
    }
    if (drug.allergyGroup) {
      warnings.push(`CDS Grubu: ${drug.allergyGroup} (Etken: ${drug.genericName || '-'})`);
    }
    hint.textContent = warnings.join(' · ');
    hint.className = qty > Number(drug.stock ?? 0) ? 'rx-stock-hint is-warn' : 'rx-stock-hint';
  });
}

function openNewPrescriptionModal(onDone) {
  const activeEncs = cachedEncounters.filter((e) => e.status === 'Open' || e.status === 'Admitted');
  if (!activeEncs.length) {
    toast('Reçete yazılacak açık/yatan karşılaşma bulunamadı.', 'warning');
    return;
  }
  if (!cachedDrugs.length) {
    toast('Aktif ilaç kataloğu boş.', 'warning');
    return;
  }

  const encOptions = activeEncs.map((e) => `
    <option value="${esc(e.id)}">#${esc(e.id)} — ${esc(patientDisplayName(e))} (${esc(e.chiefComplaint || e.encounterType)})</option>
  `).join('');

  let rowSeq = 1;
  showModal(
    'Çok Kalemli e-Reçete Düzenle',
    `<form id="form-new-rx" class="form-grid">
      <label class="field field-full">
        <span>Karşılaşma *</span>
        <select name="encounterId" required>${encOptions}</select>
      </label>
      <div class="field field-full">
        <div class="rx-composer-head">
          <span>İlaç Kalemleri (Otomatik İlaç–Alerji CDS & Stok Kontrolü)</span>
          <button type="button" id="btn-add-rx-row" class="btn btn-sm btn-ghost">+ Kalem Ekle</button>
        </div>
        <div id="rx-rows-wrap" class="rx-rows-wrap">
          ${createRxRowHtml(rowSeq, cachedDrugs[0]?.id)}
        </div>
      </div>
      ${formActions('e-Reçeteyi İmzala & Gönder')}
    </form>`,
    'E-REÇETE / CDS',
    true,
  );

  const wrap = $('#rx-rows-wrap');
  updateRxStockHints(wrap);

  $('#btn-add-rx-row')?.addEventListener('click', () => {
    rowSeq += 1;
    wrap?.insertAdjacentHTML('beforeend', createRxRowHtml(rowSeq, cachedDrugs[Math.min(rowSeq - 1, cachedDrugs.length - 1)]?.id));
    updateRxStockHints(wrap);
  });

  wrap?.addEventListener('click', (e) => {
    const rmBtn = e.target.closest('.rx-remove-btn');
    if (!rmBtn) return;
    if ($$('.rx-item-row', wrap).length <= 1) {
      toast('Reçete en az 1 kalem içermelidir.', 'warning');
      return;
    }
    rmBtn.closest('.rx-item-row')?.remove();
  });

  wrap?.addEventListener('change', () => updateRxStockHints(wrap));
  wrap?.addEventListener('input', () => updateRxStockHints(wrap));

  $('#form-new-rx')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const encounterId = Number(e.target.querySelector('[name="encounterId"]')?.value);
    const items = $$('.rx-item-row', wrap).map((row) => ({
      drugId: Number(row.querySelector('[name="drugId"]')?.value),
      dosage: String(row.querySelector('[name="dosage"]')?.value || '').trim(),
      frequency: String(row.querySelector('[name="frequency"]')?.value || '').trim(),
      durationDays: Number(row.querySelector('[name="durationDays"]')?.value || 1),
      quantity: Number(row.querySelector('[name="quantity"]')?.value || 1),
      usage: String(row.querySelector('[name="usage"]')?.value || '').trim() || undefined,
    }));

    const payload = { encounterId, items };
    try {
      await api('/api/prescriptions', { method: 'POST', body: payload });
      closeModal();
      toast(`e-Reçete (${items.length} kalem) başarıyla oluşturuldu.`);
      if (onDone) await onDone();
    } catch (err) {
      if (err?.status === 409 && err?.code === 'ALLERGY_CONFLICT') {
        showAllergyConflictModal({
          conflict: err.payload,
          pendingPayload: payload,
          onSuccess: async () => {
            if (onDone) await onDone();
          },
        });
        return;
      }
      toast(err?.message || 'Reçete oluşturulamadı.', 'error');
    }
  });
}

function openStockReceiptModal(drug, onDone) {
  const defaultRef = `IRS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${drug.code || drug.id}`;
  const idemKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  showModal(
    `Depo Mal Kabul — ${drug.name}`,
    `<form id="form-stock-receipt" class="form-grid">
      <div class="field field-full muted">
        Mevcut Stok: <strong>${esc(drug.stock)}</strong> · Minimum Eşik: <strong>${esc(drug.minStock ?? 0)}</strong>
      </div>
      <label class="field">
        <span>Giriş Miktarı *</span>
        <input type="number" name="quantity" required min="1" max="50000" value="50" />
      </label>
      <label class="field">
        <span>İrsaliye / Referans No *</span>
        <input name="reference" required value="${esc(defaultRef)}" />
      </label>
      ${formActions('Stoka Al (Idempotent)')}
    </form>`,
    'İLAÇ STOK GİRİŞİ',
  );

  $('#form-stock-receipt')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/drugs/stock-receipt', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: {
          drugId: Number(drug.id),
          quantity: Number(fd.get('quantity')),
          reference: String(fd.get('reference') || '').trim(),
        },
      });
      closeModal();
      toast(`${drug.name} stoğu güncellendi.`);
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Stok girişi başarısız.', 'error');
    }
  });
}

async function openStockLedgerModal(drug) {
  try {
    const movements = await api(`/api/drugs/${drug.id}/movements`);
    const rows = (Array.isArray(movements) ? movements : []).map((m) => `
      <tr>
        <td>${badge(m.movementType)}</td>
        <td><strong class="${Number(m.qtyDelta) >= 0 ? 'text-success' : 'text-danger'}">${Number(m.qtyDelta) >= 0 ? `+${esc(m.qtyDelta)}` : esc(m.qtyDelta)}</strong></td>
        <td>${esc(m.referenceNo || (m.prescriptionId ? `Rx #${m.prescriptionId}` : '-'))}</td>
        <td>${esc(m.actor || '-')}</td>
        <td>${esc(dateTime(m.createdAt))}</td>
      </tr>
    `).join('');

    showModal(
      `Stok Hareket Defteri — ${drug.name}`,
      rows
        ? table(['Hareket Türü', 'Miktar Değişimi', 'Referans / Reçete', 'İşlemi Yapan', 'Tarih'], rows)
        : empty('Bu ilaç için stok hareketi kaydedilmemiş.'),
      'ECZANE STOK DEFTERİ',
      true,
    );
  } catch (err) {
    toast(err?.message || 'Stok hareketleri yüklenemedi.', 'error');
  }
}

export async function renderPharmacy() {
  const canPrescribe = hasRole('admin', 'doctor');
  const canPharmacistOps = hasRole('admin', 'pharmacist');

  const [drugs, prescriptions, encounters] = await Promise.all([
    api('/api/drugs'),
    api('/api/prescriptions'),
    canPrescribe ? api('/api/encounters').catch(() => []) : Promise.resolve([]),
  ]);

  cachedDrugs = Array.isArray(drugs) ? drugs : [];
  cachedPrescriptions = Array.isArray(prescriptions) ? prescriptions : [];
  cachedEncounters = Array.isArray(encounters) ? encounters : [];

  const drugRows = cachedDrugs.map((d) => {
    const stock = Number(d.stock ?? 0);
    const minStock = Number(d.minStock ?? 0);
    const lowStock = stock <= minStock;
    return `
      <tr>
        <td>
          <strong>${esc(d.code || d.id)}</strong>
          <div class="table-sub">${esc(d.barcode || d.utsCode || '-')}</div>
        </td>
        <td>
          <div class="cell-strong">${esc(d.name)}</div>
          <div class="table-sub">${esc(d.genericName || '-')} ${d.allergyGroup ? `· CDS: ${esc(d.allergyGroup)}` : ''}</div>
        </td>
        <td>
          <span class="badge ${lowStock ? 'badge-danger' : 'badge-success'}">${esc(stock)} kutu</span>
          <div class="table-sub">Min: ${esc(minStock)}</div>
        </td>
        <td>${esc(currency(d.unitPrice))}</td>
        <td class="table-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-drug-ledger="${esc(d.id)}">Stok Defteri</button>
          ${canPharmacistOps ? `<button type="button" class="btn btn-sm btn-primary" data-drug-receipt="${esc(d.id)}">+ Mal Kabul</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  const rxRows = cachedPrescriptions.map((rx) => {
    const itemsSummary = Array.isArray(rx.items) && rx.items.length
      ? rx.items.map((it) => `${it.drugName || `İlaç #${it.drugId}`} (${it.quantity}x, ${it.dosage})`).join(', ')
      : `${rx.itemCount ?? 1} kalem`;
    const canDispense = canPharmacistOps && (rx.status === 'Pending' || rx.status === 'PartiallyDispensed');

    return `
      <tr>
        <td><strong>#${esc(rx.id)}</strong></td>
        <td>
          <div class="cell-strong">${esc(patientDisplayName(rx))}</div>
          <div class="table-sub">${esc(rx.mrn || '')}</div>
        </td>
        <td>
          <div>${esc(itemsSummary)}</div>
          ${(rx.overrideAllergy || rx.allergyOverridden) ? `<div class="table-sub text-danger">⚠ Hekim Override: ${esc(rx.overrideReason || 'Klinik onaylı')}</div>` : ''}
        </td>
        <td>${esc(rx.prescribedBy || '-')}</td>
        <td>${badge(rx.status || 'Pending')}</td>
        <td>${esc(dateTime(rx.createdAt))}</td>
        <td>
          ${canDispense ? `<button type="button" class="btn btn-sm btn-success" data-dispense-rx="${esc(rx.id)}">Teslim Et</button>` : (rx.dispensedAt ? `<span class="muted">${esc(dateTime(rx.dispensedAt))}</span>` : '-')}
        </td>
      </tr>
    `;
  }).join('');

  const headerActions = canPrescribe
    ? '<button type="button" id="btn-new-rx" class="btn btn-primary btn-sm">+ Yeni e-Reçete</button>'
    : '';

  return `
    ${heading('ECZANE & İLAÇ CDS', 'Eczane & e-Reçete', 'İlaç–alerji klinik karar destek kontrolü, çok kalemli e-reçete ve stok hareket defteri', headerActions)}

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>E-Reçete Kuyruğu</h2>
          <p class="panel-sub">Bekleyen reçetelerin İTS barkod ve stok düşümü ile teslimi</p>
        </div>
      </div>
      ${cachedPrescriptions.length
        ? table(['ID', 'Hasta', 'Kalemler / CDS', 'Hekim', 'Durum', 'Oluşturulma', 'Teslim'], rxRows)
        : empty('Kayıtlı e-reçete yok.')}
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>İlaç Envanteri & Stok Defteri</h2>
          <p class="panel-sub">Etken madde, alerji grubu, İTS barkod ve hareket geçmişi</p>
        </div>
      </div>
      ${cachedDrugs.length
        ? table(['Kod / Barkod', 'İlaç / Etken Madde', 'Stok', 'Birim Fiyat', 'İşlemler'], drugRows)
        : empty('İlaç kataloğunda kayıt yok.')}
    </section>
  `;
}

export function bindPharmacyEvents(container, { reload }) {
  if (!container) return;

  container.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-new-rx')) {
      openNewPrescriptionModal(reload);
      return;
    }

    const ledgerBtn = e.target.closest('[data-drug-ledger]');
    if (ledgerBtn) {
      const drug = cachedDrugs.find((d) => String(d.id) === String(ledgerBtn.dataset.drugLedger));
      if (drug) await openStockLedgerModal(drug);
      return;
    }

    const receiptBtn = e.target.closest('[data-drug-receipt]');
    if (receiptBtn) {
      const drug = cachedDrugs.find((d) => String(d.id) === String(receiptBtn.dataset.drugReceipt));
      if (drug) openStockReceiptModal(drug, reload);
      return;
    }

    const dispenseBtn = e.target.closest('[data-dispense-rx]');
    if (dispenseBtn) {
      const id = dispenseBtn.dataset.dispenseRx;
      try {
        await api(`/api/prescriptions/${id}/dispense`, { method: 'POST' });
        toast(`Reçete #${id} teslim edildi ve stoktan düşüldü.`);
        await reload();
      } catch (err) {
        toast(err?.message || 'Reçete teslim edilemedi.', 'error');
      }
    }
  });
}
