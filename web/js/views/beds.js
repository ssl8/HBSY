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
import { computeNews2 } from '../news2.js';
import { hasRole } from '../state.js';
import { openPatientDrawer } from '../components/patient-drawer.js';

let cachedBeds = [];
let cachedAdmissions = [];
let cachedEncounters = [];

function openAdmitModal(onDone) {
  const availableBeds = cachedBeds.filter((b) => b.status === 'Available');
  const activeAdmittedEncs = new Set(cachedAdmissions.filter((a) => !a.dischargedAt).map((a) => String(a.encounterId)));
  const eligibleEncs = cachedEncounters.filter((e) => (e.status === 'Open' || e.status === 'Admitted') && !activeAdmittedEncs.has(String(e.id)));

  if (!availableBeds.length) {
    toast('Şu anda boş yatak bulunmuyor.', 'warning');
    return;
  }
  if (!eligibleEncs.length) {
    toast('Yatış verilebilecek uygun açık karşılaşma bulunamadı.', 'warning');
    return;
  }

  const bedOptions = availableBeds.map((b) => `<option value="${esc(b.id)}">${esc(b.ward)} — Yatak ${esc(b.bedNo)}</option>`).join('');
  const encOptions = eligibleEncs.map((e) => `<option value="${esc(e.id)}">#${esc(e.id)} — ${esc(patientDisplayName(e))} (${esc(e.chiefComplaint || e.encounterType)})</option>`).join('');

  showModal(
    'Servis Yatışı (ADT Admission)',
    `<form id="form-new-admission" class="form-grid">
      <label class="field field-full">
        <span>Karşılaşma *</span>
        <select name="encounterId" required>${encOptions}</select>
      </label>
      <label class="field field-full">
        <span>Boş Yatak Seçin *</span>
        <select name="bedId" required>${bedOptions}</select>
      </label>
      ${formActions('Yatışı Tamamla')}
    </form>`,
    'YATIŞ İŞLEMİ',
  );

  $('#form-new-admission')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/admissions', {
        method: 'POST',
        body: {
          encounterId: Number(fd.get('encounterId')),
          bedId: Number(fd.get('bedId')),
        },
      });
      closeModal();
      toast('Hasta servis yatışı tamamlandı.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Yatış yapılamadı.', 'error');
    }
  });
}

function openVitalsNews2Modal(admission, onDone) {
  const encId = admission.encounterId;
  const patLabel = patientDisplayName(admission);
  showModal(
    `Hemşirelik Vital Bulgular & NEWS2 — ${patLabel}`,
    `<form id="form-bed-vitals" class="form-grid">
      <div id="bed-news2-preview" class="news2-preview field-full"></div>
      <label class="field">
        <span>Sistolik KB (mmHg) *</span>
        <input type="number" name="systolicBp" required min="40" max="260" value="124" />
      </label>
      <label class="field">
        <span>Diyastolik KB (mmHg) *</span>
        <input type="number" name="diastolicBp" required min="20" max="160" value="78" />
      </label>
      <label class="field">
        <span>Nabız (atım/dk) *</span>
        <input type="number" name="heartRate" required min="20" max="240" value="84" />
      </label>
      <label class="field">
        <span>Solunum Sayısı (/dk) *</span>
        <input type="number" name="respRate" required min="4" max="60" value="18" />
      </label>
      <label class="field">
        <span>Ateş (°C) *</span>
        <input type="number" name="tempC" step="0.1" required min="30" max="44" value="37.1" />
      </label>
      <label class="field">
        <span>SpO₂ (%) *</span>
        <input type="number" name="spo2" required min="50" max="100" value="97" />
      </label>
      <label class="field field-full">
        <span>Bilinç (AVPU) *</span>
        <select name="consciousness" required>
          <option value="A">A — Alert (Uyanık)</option>
          <option value="V">V — Voice (Sesli Uyaran)</option>
          <option value="P">P — Pain (Ağrılı Uyaran)</option>
          <option value="U">U — Unresponsive (Yanıtsız)</option>
        </select>
      </label>
      ${formActions('Vital Bulguları Kaydet')}
    </form>`,
    'HEMŞİRELİK GÖZLEM / NEWS2',
  );

  const form = $('#form-bed-vitals');
  const preview = $('#bed-news2-preview');

  const refreshPreview = () => {
    if (!form || !preview) return;
    const fd = new FormData(form);
    const res = computeNews2({
      systolicBp: Number(fd.get('systolicBp')),
      heartRate: Number(fd.get('heartRate')),
      respRate: Number(fd.get('respRate')),
      tempC: Number(fd.get('tempC')),
      spo2: Number(fd.get('spo2')),
      consciousness: String(fd.get('consciousness') || 'A'),
    });
    const riskCls = res.risk === 'HIGH'
      ? 'badge-danger'
      : (res.risk === 'MEDIUM' || res.risk === 'LOW_MEDIUM' ? 'badge-warning' : 'badge-success');
    preview.innerHTML = `
      <div class="news2-live-row">
        <span>Canlı NEWS2 Klinik Risk Skoru:</span>
        <span class="badge ${riskCls}">NEWS2 = ${esc(res.score)} (${esc(res.risk)})</span>
      </div>
    `;
  };

  refreshPreview();
  form?.addEventListener('input', refreshPreview);
  form?.addEventListener('change', refreshPreview);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const saved = await api(`/api/encounters/${encId}/vitals`, {
        method: 'POST',
        body: {
          systolicBp: Number(fd.get('systolicBp')),
          diastolicBp: Number(fd.get('diastolicBp')),
          heartRate: Number(fd.get('heartRate')),
          respRate: Number(fd.get('respRate')),
          tempC: Number(fd.get('tempC')),
          spo2: Number(fd.get('spo2')),
          consciousness: String(fd.get('consciousness') || 'A'),
        },
      });
      closeModal();
      toast(`Vital bulgular kaydedildi (NEWS2: ${saved.news2Score ?? '-'})`);
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Vital bulgular kaydedilemedi.', 'error');
    }
  });
}

function openTransferModal(admission, onDone) {
  const availableBeds = cachedBeds.filter((b) => b.status === 'Available' && String(b.id) !== String(admission.bedId));
  if (!availableBeds.length) {
    toast('Transfer edilecek başka boş yatak yok.', 'warning');
    return;
  }

  const options = availableBeds.map((b) => `<option value="${esc(b.id)}">${esc(b.ward)} — Yatak ${esc(b.bedNo)}</option>`).join('');

  showModal(
    `Yatak Transferi — Yatış #${admission.id}`,
    `<form id="form-bed-transfer" class="form-grid">
      <div class="field field-full muted">
        Mevcut Yatak: <strong>${esc(admission.ward || '-')} / ${esc(admission.bedNo || admission.bedId)}</strong>
      </div>
      <label class="field field-full">
        <span>Hedef Yatak *</span>
        <select name="newBedId" required>${options}</select>
      </label>
      <label class="field field-full">
        <span>Transfer Nedeni *</span>
        <input name="reason" required value="Klinik takip düzeyinde değişiklik" />
      </label>
      ${formActions('Transferi Onayla')}
    </form>`,
    'YATAK TRANSFERİ',
  );

  $('#form-bed-transfer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/admissions/${admission.id}/transfer`, {
        method: 'POST',
        body: {
          newBedId: Number(fd.get('newBedId')),
          reason: String(fd.get('reason') || '').trim(),
        },
      });
      closeModal();
      toast('Yatak transferi tamamlandı.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Yatak transferi başarısız.', 'error');
    }
  });
}

async function openTransferHistoryModal(admissionId) {
  try {
    const list = await api(`/api/admissions/${admissionId}/transfers`);
    const rows = (Array.isArray(list) ? list : []).map((t) => `
      <tr>
        <td>${esc(t.fromWard ? `${t.fromWard} / ${t.fromBedNo}` : (t.fromBedNo || t.fromBedId || '-'))}</td>
        <td>→</td>
        <td><strong>${esc(t.toWard ? `${t.toWard} / ${t.toBedNo}` : (t.toBedNo || t.toBedId || '-'))}</strong></td>
        <td>${esc(t.reason || '-')}</td>
        <td>${esc(t.transferredBy || '-')}</td>
        <td>${esc(dateTime(t.transferredAt))}</td>
      </tr>
    `).join('');

    showModal(
      `Yatak Transfer Geçmişi (Yatış #${admissionId})`,
      rows
        ? table(['Önceki Yatak', '', 'Yeni Yatak', 'Neden', 'İşlemi Yapan', 'Tarih'], rows)
        : empty('Bu yatış için transfer hareketi kaydedilmemiş.'),
      'TRANSFER DEFTERİ',
      true,
    );
  } catch (err) {
    toast(err?.message || 'Transfer geçmişi yüklenemedi.', 'error');
  }
}

export async function renderBeds() {
  const canAdmit = hasRole('admin', 'doctor', 'nurse', 'registrar');
  const [beds, admissions, encounters] = await Promise.all([
    api('/api/beds'),
    api('/api/admissions'),
    canAdmit ? api('/api/encounters').catch(() => []) : Promise.resolve([]),
  ]);

  cachedBeds = Array.isArray(beds) ? beds : [];
  cachedAdmissions = Array.isArray(admissions) ? admissions : [];
  cachedEncounters = Array.isArray(encounters) ? encounters : [];

  const canNurseActions = hasRole('admin', 'doctor', 'nurse');
  const canClean = hasRole('admin', 'nurse');
  const canDischarge = hasRole('admin', 'doctor', 'nurse', 'registrar');

  const bedCards = cachedBeds.map((b) => {
    const cleanBtn = b.status === 'Cleaning' && canClean
      ? `<button type="button" class="btn btn-sm btn-success" data-clean-bed="${esc(b.id)}">Temizliği Tamamla</button>`
      : '';
    return `
      <article class="bed-card bed-status-${esc(String(b.status || 'Available').toLowerCase())}">
        <div class="bed-card-head">
          <strong>${esc(b.bedNo)}</strong>
          ${badge(b.status)}
        </div>
        <div class="bed-ward">${esc(b.ward || 'Genel Servis')}</div>
        ${b.currentEncounterId ? `<div class="table-sub">Karşılaşma #${esc(b.currentEncounterId)}</div>` : ''}
        ${cleanBtn ? `<div class="bed-card-foot">${cleanBtn}</div>` : ''}
      </article>
    `;
  }).join('');

  const activeAdmRows = cachedAdmissions.map((a) => {
    const active = !a.dischargedAt;
    const pid = pick(a, 'patientId');
    const actions = [
      pid ? `<button type="button" class="btn btn-sm btn-ghost" data-bed-drawer="${esc(pid)}">360° EMR</button>` : '',
      active && canNurseActions ? `<button type="button" class="btn btn-sm btn-primary" data-vitals-adm="${esc(a.id)}">Vital & NEWS2</button>` : '',
      active && canAdmit ? `<button type="button" class="btn btn-sm btn-ghost" data-transfer-adm="${esc(a.id)}">Transfer</button>` : '',
      `<button type="button" class="btn btn-sm btn-ghost" data-history-adm="${esc(a.id)}">Geçmiş</button>`,
      active && canDischarge ? `<button type="button" class="btn btn-sm btn-amber" data-discharge-adm="${esc(a.id)}">Taburcu</button>` : '',
    ].filter(Boolean).join(' ');

    return `
      <tr>
        <td><strong>#${esc(a.id)}</strong></td>
        <td>
          <div class="cell-strong">${esc(patientDisplayName(a))}</div>
          <div class="table-sub">${esc(a.mrn || '')}</div>
        </td>
        <td>${esc(a.ward || '-')} / <strong>${esc(a.bedNo || a.bedId)}</strong></td>
        <td>${active ? badge('Admitted') : badge('Discharged')}</td>
        <td>${esc(dateTime(a.admittedAt))}</td>
        <td>${esc(a.dischargedAt ? dateTime(a.dischargedAt) : '-')}</td>
        <td class="table-actions">${actions}</td>
      </tr>
    `;
  }).join('');

  const headerBtn = canAdmit ? '<button type="button" id="btn-new-admission" class="btn btn-primary btn-sm">+ Yeni Yatış</button>' : '';

  return `
    ${heading('ADT & YATAK YÖNETİMİ', 'Yataklar & Servis Yatışı', 'Servis doluluk durumu, yatak temizliği, transfer geçmişi ve hemşirelik NEWS2 takibi', headerBtn)}

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Servis Yatak Haritası</h2>
          <p class="panel-sub">${esc(cachedBeds.filter((b) => b.status === 'Available').length)} boş · ${esc(cachedBeds.filter((b) => b.status === 'Occupied').length)} dolu · ${esc(cachedBeds.filter((b) => b.status === 'Cleaning').length)} temizlik bekliyor</p>
        </div>
      </div>
      ${cachedBeds.length ? `<div class="bed-grid">${bedCards}</div>` : empty('Tanımlı yatak bulunamadı.')}
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Yatış & Transfer Hareketleri</h2>
          <p class="panel-sub">Hemşire vital girişi, oda/yatak transferi ve taburculuk işlemleri</p>
        </div>
      </div>
      ${cachedAdmissions.length
        ? table(['ID', 'Hasta', 'Servis / Yatak', 'Durum', 'Yatış Tarihi', 'Taburculuk', 'İşlemler'], activeAdmRows)
        : empty('Yatış kaydı bulunmuyor.')}
    </section>
  `;
}

export function bindBedsEvents(container, { reload }) {
  if (!container) return;

  container.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-new-admission')) {
      openAdmitModal(reload);
      return;
    }

    const cleanBtn = e.target.closest('[data-clean-bed]');
    if (cleanBtn) {
      const id = cleanBtn.dataset.cleanBed;
      try {
        await api(`/api/beds/${id}/cleaning-complete`, { method: 'POST' });
        toast(`Yatak #${id} temizlendi ve kullanıma hazır.`);
        await reload();
      } catch (err) {
        toast(err?.message || 'Temizlik güncellenemedi.', 'error');
      }
      return;
    }

    const vitalsBtn = e.target.closest('[data-vitals-adm]');
    if (vitalsBtn) {
      const adm = cachedAdmissions.find((a) => String(a.id) === String(vitalsBtn.dataset.vitalsAdm));
      if (adm) openVitalsNews2Modal(adm, reload);
      return;
    }

    const transferBtn = e.target.closest('[data-transfer-adm]');
    if (transferBtn) {
      const adm = cachedAdmissions.find((a) => String(a.id) === String(transferBtn.dataset.transferAdm));
      if (adm) openTransferModal(adm, reload);
      return;
    }

    const historyBtn = e.target.closest('[data-history-adm]');
    if (historyBtn) {
      await openTransferHistoryModal(historyBtn.dataset.historyAdm);
      return;
    }

    const dischargeBtn = e.target.closest('[data-discharge-adm]');
    if (dischargeBtn) {
      const id = dischargeBtn.dataset.dischargeAdm;
      try {
        await api(`/api/admissions/${id}/discharge`, { method: 'POST' });
        toast(`Yatış #${id} taburcu edildi. Yatak temizlik durumuna alındı.`);
        await reload();
      } catch (err) {
        toast(err?.message || 'Taburculuk işlemi başarısız.', 'error');
      }
      return;
    }

    const drawerBtn = e.target.closest('[data-bed-drawer]');
    if (drawerBtn) {
      await openPatientDrawer(drawerBtn.dataset.bedDrawer);
    }
  });
}
