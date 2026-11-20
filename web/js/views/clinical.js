import { api } from '../api.js';
import {
  $,
  badge,
  closeModal,
  dateTime,
  empty,
  esc,
  formActions,
  heading,
  patientDisplayName,
  pick,
  showModal,
  table,
  toast,
} from '../dom.js';
import { hasRole, state } from '../state.js';
import { showDicomViewer } from '../components/dicom-viewer.js';
import { bindHl7SandboxEvents, renderHl7SandboxMarkup } from '../components/hl7-sandbox.js';
import { openPatientDrawer } from '../components/patient-drawer.js';

let activeTab = 'orders';
let orderFilterType = 'ALL';
let cachedOrders = [];
let cachedEncounters = [];

const FLAG_MAP = {
  N: { label: 'Normal (N)', cls: 'badge-success' },
  H: { label: 'Yüksek (H)', cls: 'badge-warning' },
  L: { label: 'Düşük (L)', cls: 'badge-warning' },
  HH: { label: 'Kritik Yüksek (HH)', cls: 'badge-danger' },
  LL: { label: 'Kritik Düşük (LL)', cls: 'badge-danger' },
  CRITICAL: { label: 'Kritik', cls: 'badge-danger' },
};

function renderFlagBadge(flag, criticalFlag) {
  const code = String(flag || (criticalFlag ? 'CRITICAL' : 'N')).toUpperCase();
  const entry = FLAG_MAP[code] || { label: code, cls: criticalFlag ? 'badge-danger' : 'badge-neutral' };
  return `<span class="badge ${entry.cls}">${esc(entry.label)}</span>`;
}

function isExecutorForOrderType(type) {
  if (hasRole('admin')) return true;
  if (type === 'LAB') return hasRole('lab');
  if (type === 'RAD') return hasRole('radiology');
  if (type === 'PROCEDURE' || type === 'CONSULT' || type === 'DRUG') return hasRole('doctor');
  return false;
}

function renderOrderActions(order) {
  const type = String(pick(order, 'orderType', 'type') || '').toUpperCase();
  const status = String(order.status || 'Created');
  const id = order.id;
  const canDocOrAdmin = hasRole('admin', 'doctor');
  const isExecutor = isExecutorForOrderType(type);
  const btns = [];

  if (status === 'Created') {
    if (canDocOrAdmin) {
      btns.push(`<button type="button" class="btn btn-sm btn-primary" data-order-status="Submitted" data-order-id="${esc(id)}">Gönder</button>`);
      btns.push(`<button type="button" class="btn btn-sm btn-ghost" data-order-status="Cancelled" data-order-id="${esc(id)}">İptal</button>`);
    }
  } else if (status === 'Submitted') {
    if (isExecutor) {
      btns.push(`<button type="button" class="btn btn-sm btn-primary" data-order-status="InProgress" data-order-id="${esc(id)}">İşleme Al</button>`);
      btns.push(`<button type="button" class="btn btn-sm btn-ghost" data-order-status="Rejected" data-order-id="${esc(id)}">Reddet</button>`);
    }
    if (canDocOrAdmin) {
      btns.push(`<button type="button" class="btn btn-sm btn-ghost" data-order-status="Cancelled" data-order-id="${esc(id)}">İptal</button>`);
    }
  } else if (status === 'Rejected') {
    if (canDocOrAdmin) {
      btns.push(`<button type="button" class="btn btn-sm btn-primary" data-order-status="Submitted" data-order-id="${esc(id)}">Yeniden Gönder</button>`);
    }
  } else if (status === 'InProgress') {
    if (isExecutor) {
      if (type === 'LAB') {
        btns.push(`<button type="button" class="btn btn-sm btn-amber" data-add-lab-for="${esc(id)}">+ Lab Sonucu</button>`);
        btns.push(`<button type="button" class="btn btn-sm btn-success" data-order-status="Resulted" data-order-id="${esc(id)}">Sonuçlandır</button>`);
      } else if (type === 'RAD') {
        btns.push(`<button type="button" class="btn btn-sm btn-amber" data-add-rad-for="${esc(id)}">+ Rapor Yaz</button>`);
        btns.push(`<button type="button" class="btn btn-sm btn-success" data-order-status="Resulted" data-order-id="${esc(id)}">Sonuçlandır</button>`);
      } else {
        btns.push(`<button type="button" class="btn btn-sm btn-success" data-order-status="Resulted" data-order-id="${esc(id)}">Sonuçlandır</button>`);
      }
    }
    if (canDocOrAdmin) {
      btns.push(`<button type="button" class="btn btn-sm btn-ghost" data-order-status="Cancelled" data-order-id="${esc(id)}">İptal</button>`);
    }
  } else if (status === 'Resulted') {
    if (canDocOrAdmin) {
      btns.push(`<button type="button" class="btn btn-sm btn-success" data-order-status="Verified" data-order-id="${esc(id)}">Hekim Onayı</button>`);
    }
  }

  return btns.join(' ');
}

function openNewOrderModal(onDone) {
  const encOptions = cachedEncounters
    .filter((e) => e.status === 'Open' || e.status === 'Admitted')
    .map((e) => `<option value="${esc(e.id)}">#${esc(e.id)} — ${esc(patientDisplayName(e))} (${esc(e.chiefComplaint || e.encounterType)})</option>`)
    .join('');

  if (!encOptions) {
    toast('İstem oluşturmak için açık karşılaşma bulunamadı.', 'warning');
    return;
  }

  showModal(
    'Yeni Klinik İstem Oluştur',
    `<form id="form-new-order" class="form-grid">
      <label class="field field-full">
        <span>Karşılaşma *</span>
        <select name="encounterId" required>${encOptions}</select>
      </label>
      <label class="field">
        <span>İstem Türü *</span>
        <select name="orderType" id="order-type-select" required>
          <option value="LAB">Laboratuvar (LAB)</option>
          <option value="RAD">Radyoloji (RAD)</option>
          <option value="PROCEDURE">Girişim / İşlem (PROCEDURE)</option>
          <option value="CONSULT">Konsültasyon (CONSULT)</option>
        </select>
      </label>
      <label class="field">
        <span>Öncelik *</span>
        <select name="priority">
          <option value="R">Rutin (R)</option>
          <option value="U">Öncelikli (U)</option>
          <option value="S">Acil / STAT (S)</option>
        </select>
      </label>
      <label class="field">
        <span>Kod Sistemi *</span>
        <select name="codeSystem" id="order-cs-select">
          <option value="LOINC">LOINC</option>
          <option value="SUT">SUT</option>
          <option value="ICD-10">ICD-10</option>
        </select>
      </label>
      <label class="field">
        <span>Tetkik / İşlem Kodu *</span>
        <input name="code" required value="58410-2" />
      </label>
      <label class="field field-full">
        <span>Açıklama *</span>
        <input name="description" required placeholder="Örn: Tam Kan Sayımı (Hemogram) veya Akciğer Grafisi PA" />
      </label>
      <label class="field field-full">
        <span>Klinik Not</span>
        <textarea name="clinicalNote" rows="2" placeholder="Ön tanı veya istem gerekçesi..."></textarea>
      </label>
      ${formActions('İstem Oluştur')}
    </form>`,
    'KLİNİK İSTEM',
  );

  $('#order-type-select')?.addEventListener('change', (e) => {
    const cs = $('#order-cs-select');
    if (!cs) return;
    if (e.target.value === 'LAB') cs.value = 'LOINC';
    else cs.value = 'SUT';
  });

  $('#form-new-order')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      encounterId: Number(fd.get('encounterId')),
      orderType: String(fd.get('orderType')),
      codeSystem: String(fd.get('codeSystem')),
      code: String(fd.get('code') || '').trim(),
      description: String(fd.get('description') || '').trim(),
      priority: String(fd.get('priority') || 'R'),
      clinicalNote: String(fd.get('clinicalNote') || '').trim() || undefined,
    };
    try {
      await api('/api/orders', { method: 'POST', body: payload });
      closeModal();
      toast('Klinik istem oluşturuldu.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'İstem kaydedilemedi.', 'error');
    }
  });
}

function openAddLabResultModal(preselectedOrderId, onDone) {
  const labOrders = cachedOrders.filter((o) => String(o.orderType).toUpperCase() === 'LAB' && o.status !== 'Verified' && o.status !== 'Cancelled');
  const options = labOrders.map((o) => {
    const sel = String(o.id) === String(preselectedOrderId) ? 'selected' : '';
    return `<option value="${esc(o.id)}" ${sel}>#${esc(o.id)} — ${esc(o.description)} (${esc(patientDisplayName(o))})</option>`;
  }).join('');

  if (!options) {
    toast('Sonuç girilecek aktif LAB istemi yok.', 'warning');
    return;
  }

  showModal(
    'Laboratuvar Sonucu Gir',
    `<form id="form-new-lab" class="form-grid">
      <label class="field field-full">
        <span>LAB İstemi *</span>
        <select name="orderId" required>${options}</select>
      </label>
      <label class="field">
        <span>Analit Kodu (LOINC) *</span>
        <input name="analyteCode" required value="6598-7" />
      </label>
      <label class="field">
        <span>Parametre Adı *</span>
        <input name="display" required value="Troponin I (High Sensitivity)" />
      </label>
      <label class="field">
        <span>Sonuç Değeri *</span>
        <input name="value" required value="0.48" />
      </label>
      <label class="field">
        <span>Birim</span>
        <input name="unit" value="ng/mL" />
      </label>
      <label class="field">
        <span>Referans Aralığı</span>
        <input name="referenceRange" value="0.00 - 0.04" />
      </label>
      <label class="field">
        <span>Bayrak (Flag) *</span>
        <select name="flag" required>
          <option value="N">N — Normal</option>
          <option value="H">H — Yüksek</option>
          <option value="L">L — Düşük</option>
          <option value="HH" selected>HH — Kritik Yüksek</option>
          <option value="LL">LL — Kritik Düşük</option>
        </select>
      </label>
      <label class="field field-checkbox field-full">
        <input type="checkbox" name="critical" checked />
        <span>Kritik Panik Değer (Hekim Read-Back Onayı Gerektirir)</span>
      </label>
      ${formActions('Sonucu Kaydet')}
    </form>`,
    'LİS SONUÇ GİRİŞİ',
  );

  $('#form-new-lab')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const flag = String(fd.get('flag') || 'N');
    const isCrit = fd.get('critical') === 'on' || flag === 'HH' || flag === 'LL';
    try {
      await api('/api/lab-results', {
        method: 'POST',
        body: {
          orderId: Number(fd.get('orderId')),
          analyteCode: String(fd.get('analyteCode') || '').trim(),
          display: String(fd.get('display') || '').trim(),
          value: String(fd.get('value') || '').trim(),
          unit: String(fd.get('unit') || '').trim() || undefined,
          referenceRange: String(fd.get('referenceRange') || '').trim() || undefined,
          flag,
          critical: isCrit,
        },
      });
      closeModal();
      toast('Laboratuvar sonucu kaydedildi.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Lab sonucu kaydedilemedi.', 'error');
    }
  });
}

function openAddRadReportModal(preselectedOrderId, onDone) {
  const radOrders = cachedOrders.filter((o) => String(o.orderType).toUpperCase() === 'RAD' && o.status !== 'Verified' && o.status !== 'Cancelled');
  const options = radOrders.map((o) => {
    const sel = String(o.id) === String(preselectedOrderId) ? 'selected' : '';
    return `<option value="${esc(o.id)}" ${sel}>#${esc(o.id)} — ${esc(o.description)} (${esc(patientDisplayName(o))})</option>`;
  }).join('');

  if (!options) {
    toast('Raporlanacak aktif RAD istemi yok.', 'warning');
    return;
  }

  showModal(
    'Radyoloji Raporu Yaz',
    `<form id="form-new-rad" class="form-grid">
      <label class="field field-full">
        <span>Radyoloji İstemi *</span>
        <select name="orderId" required>${options}</select>
      </label>
      <label class="field field-full">
        <span>Radyolojik Bulgular (Rapor Metni) *</span>
        <textarea name="reportText" rows="4" required placeholder="Her iki akciğer parankimi, mediastinal yapılar ve kostofrenik sinüsler değerlendirildi..."></textarea>
      </label>
      <label class="field field-full">
        <span>Sonuç / İzlenim (Impression) *</span>
        <input name="impression" required placeholder="Kısa radyolojik sonuç özeti" />
      </label>
      ${formActions('Raporu Kaydet')}
    </form>`,
    'RADYOLOJİ / PACS',
  );

  $('#form-new-rad')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/radiology-reports', {
        method: 'POST',
        body: {
          orderId: Number(fd.get('orderId')),
          reportText: String(fd.get('reportText') || '').trim(),
          impression: String(fd.get('impression') || '').trim(),
        },
      });
      closeModal();
      toast('Radyoloji raporu kaydedildi.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Rapor kaydedilemedi.', 'error');
    }
  });
}

function openCriticalAckModal(labRow, onDone) {
  showModal(
    'Kritik Laboratuvar Değeri Read-Back Onayı',
    `<div class="alert-banner alert-danger">
      <strong>Kritik Sonuç:</strong> ${esc(labRow.display)} = ${esc(labRow.value)} ${esc(labRow.unit || '')}
      (${esc(patientDisplayName(labRow))})
    </div>
    <form id="form-crit-ack" class="form-grid">
      <label class="field field-full">
        <span>Bildirimi Yapan / İletişim Kurulan Kişi *</span>
        <input name="communicatedWith" required value="Nöbetçi LİS Uzmanı — Telefon Read-Back" />
      </label>
      <label class="field field-full">
        <span>Klinik Aksiyon / Onay Notu *</span>
        <textarea name="ackNote" rows="3" required placeholder="Değer telefon ile teyit edildi, hasta başı değerlendirme başlatıldı."></textarea>
      </label>
      ${formActions('Kritik Okumayı Onayla')}
    </form>`,
    'KRİTİK DEĞER READ-BACK',
  );

  $('#form-crit-ack')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/lab-results/${labRow.id}/acknowledge`, {
        method: 'POST',
        body: {
          communicatedWith: String(fd.get('communicatedWith') || '').trim(),
          ackNote: String(fd.get('ackNote') || '').trim(),
        },
      });
      closeModal();
      toast('Kritik değer okuma onayı kaydedildi.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Kritik onay kaydedilemedi.', 'error');
    }
  });
}

let cachedLabs = [];

export async function renderClinical() {
  const canCreateOrder = hasRole('admin', 'doctor');
  const [orders, labs, rads, encounters] = await Promise.all([
    api('/api/orders').catch(() => []),
    api('/api/lab-results').catch(() => []),
    api('/api/radiology-reports').catch(() => []),
    canCreateOrder ? api('/api/encounters').catch(() => []) : Promise.resolve([]),
  ]);

  cachedOrders = Array.isArray(orders) ? orders : [];
  state.orders = cachedOrders;
  cachedLabs = Array.isArray(labs) ? labs : [];
  cachedEncounters = Array.isArray(encounters) ? encounters : [];
  const radList = Array.isArray(rads) ? rads : [];

  const unackedCritical = cachedLabs.filter((l) => Boolean(l.criticalFlag ?? l.critical) && !l.criticalAckBy);

  const filteredOrders = orderFilterType === 'ALL'
    ? cachedOrders
    : cachedOrders.filter((o) => String(o.orderType).toUpperCase() === orderFilterType);

  const orderRows = filteredOrders.map((o) => {
    const pid = pick(o, 'patientId');
    const drawerBtn = pid ? `<button type="button" class="btn btn-sm btn-ghost" data-clinical-drawer="${esc(pid)}">360° EMR</button>` : '';
    return `
      <tr>
        <td><strong>#${esc(o.id)}</strong></td>
        <td>
          <div class="cell-strong">${esc(patientDisplayName(o))}</div>
          <div class="table-sub">${esc(o.mrn || '')}</div>
        </td>
        <td>${badge(o.orderType)}</td>
        <td>
          <div class="cell-strong">${esc(o.description)}</div>
          <div class="table-sub">${esc(o.codeSystem || 'LOINC')}: ${esc(o.code || '-')}</div>
        </td>
        <td>${badge(o.priority || 'R')}</td>
        <td>${badge(o.status || 'Created')}</td>
        <td>${esc(dateTime(o.createdAt))}</td>
        <td class="table-actions">${renderOrderActions(o)} ${drawerBtn}</td>
      </tr>
    `;
  }).join('');

  const labRows = cachedLabs.map((l) => {
    const isCrit = Boolean(l.criticalFlag ?? l.critical);
    const ackedBy = l.criticalAckBy;
    let ackCell = '<span class="muted">Rutin</span>';
    if (isCrit && ackedBy) {
      ackCell = `<span class="badge badge-success">✔ ${esc(ackedBy)}</span><div class="table-sub">${esc(l.criticalAckNote || dateTime(l.criticalAckAt))}</div>`;
    } else if (isCrit) {
      ackCell = hasRole('doctor', 'admin')
        ? `<button type="button" class="btn btn-sm btn-danger" data-ack-lab="${esc(l.id)}">Kritik Okuma Onayı</button>`
        : '<span class="badge badge-danger">Hekim Onayı Bekliyor</span>';
    }
    return `
      <tr class="${isCrit && !ackedBy ? 'row-critical-alert' : ''}">
        <td><strong>#${esc(l.id)}</strong></td>
        <td>${esc(patientDisplayName(l))}</td>
        <td>
          <div class="cell-strong">${esc(l.display)}</div>
          <div class="table-sub">${esc(l.analyteCode || '-')}</div>
        </td>
        <td><strong>${esc(l.value)}</strong> ${esc(l.unit || '')}</td>
        <td>${esc(l.referenceRange || '-')}</td>
        <td>${renderFlagBadge(l.flag, isCrit)}</td>
        <td>${esc(dateTime(l.resultedAt || l.createdAt))}</td>
        <td>${ackCell}</td>
      </tr>
    `;
  }).join('');

  const radRows = radList.map((r) => `
    <tr>
      <td><strong>#${esc(r.id)}</strong></td>
      <td>${esc(patientDisplayName(r))}</td>
      <td>${badge(r.modality || 'RAD')}</td>
      <td>
        <div class="cell-strong">${esc(r.impression || '-')}</div>
        <div class="table-sub">${esc(String(r.reportText || '').slice(0, 120))}</div>
      </td>
      <td>${esc(r.reportedBy || '-')}</td>
      <td>${esc(dateTime(r.reportedAt || r.createdAt))}</td>
      <td><button type="button" class="btn btn-sm btn-primary" data-dicom-id="${esc(r.id)}">DICOM Görüntüle</button></td>
    </tr>
  `).join('');

  let tabBody = '';
  if (activeTab === 'orders') {
    tabBody = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>İstem listesi</h2>
            <p class="panel-sub">OrderStateMachine durum geçişleri rol tabanlı yetkilendirilmiştir</p>
          </div>
          <div class="filter-pills">
            ${['ALL', 'LAB', 'RAD', 'PROCEDURE', 'CONSULT'].map((t) => `
              <button type="button" class="btn btn-sm ${orderFilterType === t ? 'btn-primary' : 'btn-ghost'}" data-order-filter="${esc(t)}">
                ${t === 'ALL' ? 'Tümü' : esc(t)}
              </button>
            `).join('')}
          </div>
        </div>
        ${filteredOrders.length
          ? table(['ID', 'Hasta', 'Tür', 'Tetkik / İşlem', 'Öncelik', 'Durum', 'Tarih', 'İşlemler'], orderRows)
          : empty('Kayıtlı istem bulunmuyor.')}
      </section>
    `;
  } else if (activeTab === 'labs') {
    tabBody = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Laboratuvar Sonuçları (LİS)</h2>
            <p class="panel-sub">Kritik panik değerler hekim read-back onayı alana kadar vurgulanır</p>
          </div>
          ${hasRole('admin', 'lab', 'doctor') ? '<button type="button" id="btn-add-lab-modal" class="btn btn-primary btn-sm">+ Lab Sonucu Gir</button>' : ''}
        </div>
        ${cachedLabs.length
          ? table(['ID', 'Hasta', 'Analit', 'Değer', 'Referans', 'Bayrak', 'Tarih', 'Read-Back Onayı'], labRows)
          : empty('Laboratuvar sonucu yok.')}
      </section>
    `;
  } else if (activeTab === 'rad') {
    tabBody = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Radyoloji Raporları & PACS DICOM Görüntüleyici</h2>
            <p class="panel-sub">CR, CT, MR ve US modalitelerinde pencereleme (W/L), kesit gezintisi ve milimetrik ölçüm</p>
          </div>
          ${hasRole('admin', 'radiology', 'doctor') ? '<button type="button" id="btn-add-rad-modal" class="btn btn-primary btn-sm">+ Radyoloji Raporu</button>' : ''}
        </div>
        ${radList.length
          ? table(['ID', 'Hasta', 'Modalite', 'İzlenim / Rapor', 'Raporlayan', 'Tarih', 'PACS'], radRows)
          : empty('Radyoloji raporu yok.')}
      </section>
    `;
  } else if (activeTab === 'hl7') {
    tabBody = await renderHl7SandboxMarkup();
  }

  const headerActions = [
    hasRole('admin', 'doctor') ? '<button type="button" id="btn-new-order" class="btn btn-primary btn-sm">+ Yeni İstem</button>' : '',
  ].filter(Boolean).join('');

  return `
    ${heading('KLİNİK KARAR & TANI', 'Klinik & İstemler', 'İstem iş akışı, kritik lab read-back, PACS DICOM viewer ve HL7 v2.5.1 ORU^R01', headerActions)}

    ${unackedCritical.length ? `
      <div class="alert-banner alert-danger">
        <div>
          <strong>🚨 ${esc(unackedCritical.length)} Adet Onaylanmamış Kritik Laboratuvar Sonucu Var!</strong>
          <span>${esc(unackedCritical.map((c) => `${c.display}: ${c.value} ${c.unit || ''}`).slice(0, 3).join(' · '))}</span>
        </div>
        <button type="button" class="btn btn-sm btn-danger" data-clinical-tab="labs">Sonuçları İncele</button>
      </div>
    ` : ''}

    <div class="tab-bar">
      <button type="button" class="tab-btn ${activeTab === 'orders' ? 'is-active' : ''}" data-clinical-tab="orders">İstem listesi (${esc(cachedOrders.length)})</button>
      <button type="button" class="tab-btn ${activeTab === 'labs' ? 'is-active' : ''}" data-clinical-tab="labs">LİS Sonuçları (${esc(cachedLabs.length)}) ${unackedCritical.length ? `<span class="badge badge-danger">${esc(unackedCritical.length)} Kritik</span>` : ''}</button>
      <button type="button" class="tab-btn ${activeTab === 'rad' ? 'is-active' : ''}" data-clinical-tab="rad">Radyoloji & DICOM (${esc(radList.length)})</button>
      <button type="button" class="tab-btn ${activeTab === 'hl7' ? 'is-active' : ''}" data-clinical-tab="hl7">HL7 v2.5.1 ORU^R01</button>
    </div>

    ${tabBody}
  `;
}

export function bindClinicalEvents(container, { reload }) {
  if (!container) return;

  if (activeTab === 'hl7') {
    bindHl7SandboxEvents(container, reload);
  }

  container.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-clinical-tab]');
    if (tabBtn) {
      activeTab = tabBtn.dataset.clinicalTab;
      await reload();
      return;
    }

    const filterBtn = e.target.closest('[data-order-filter]');
    if (filterBtn) {
      orderFilterType = filterBtn.dataset.orderFilter;
      await reload();
      return;
    }

    if (e.target.closest('#btn-new-order')) {
      openNewOrderModal(reload);
      return;
    }

    if (e.target.closest('#btn-add-lab-modal')) {
      openAddLabResultModal(null, reload);
      return;
    }

    if (e.target.closest('#btn-add-rad-modal')) {
      openAddRadReportModal(null, reload);
      return;
    }

    const addLabFor = e.target.closest('[data-add-lab-for]');
    if (addLabFor) {
      openAddLabResultModal(addLabFor.dataset.addLabFor, reload);
      return;
    }

    const addRadFor = e.target.closest('[data-add-rad-for]');
    if (addRadFor) {
      openAddRadReportModal(addRadFor.dataset.addRadFor, reload);
      return;
    }

    const statusBtn = e.target.closest('[data-order-status]');
    if (statusBtn) {
      const orderId = statusBtn.dataset.orderId;
      const status = statusBtn.dataset.orderStatus;
      try {
        await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status } });
        toast(`İstem #${orderId} durumu "${status}" olarak güncellendi.`);
        await reload();
      } catch (err) {
        toast(err?.message || 'Durum güncellenemedi.', 'error');
      }
      return;
    }

    const ackBtn = e.target.closest('[data-ack-lab]');
    if (ackBtn) {
      const row = cachedLabs.find((l) => String(l.id) === String(ackBtn.dataset.ackLab));
      if (row) openCriticalAckModal(row, reload);
      return;
    }

    const dicomBtn = e.target.closest('[data-dicom-id]');
    if (dicomBtn) {
      await showDicomViewer(dicomBtn.dataset.dicomId);
      return;
    }

    const drawerBtn = e.target.closest('[data-clinical-drawer]');
    if (drawerBtn) {
      await openPatientDrawer(drawerBtn.dataset.clinicalDrawer);
    }
  });
}
