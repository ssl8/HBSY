import { api } from '../api.js';
import {
  $,
  badge,
  closeModal,
  dateOnly,
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
import { hasRole } from '../state.js';
import { openPatientDrawer } from '../components/patient-drawer.js';

let currentQuery = '';
let cachedPatients = [];

function openNewPatientModal(onDone) {
  showModal(
    'Yeni Hasta Kaydı',
    `<form id="form-new-patient" class="form-grid">
      <label class="field">
        <span>TCKN (11 Hane)</span>
        <input name="nationalId" maxlength="11" pattern="[0-9]{11}" placeholder="10000000101" />
      </label>
      <label class="field">
        <span>Dosya No / MRN (Opsiyonel)</span>
        <input name="mrn" placeholder="Otomatik üretilir (ör. HB-000112)" />
      </label>
      <label class="field">
        <span>Ad *</span>
        <input name="givenName" required placeholder="Ayşe" />
      </label>
      <label class="field">
        <span>Soyad *</span>
        <input name="familyName" required placeholder="Demir" />
      </label>
      <label class="field">
        <span>Doğum Tarihi *</span>
        <input type="date" name="birthDate" required value="1988-05-14" />
      </label>
      <label class="field">
        <span>Cinsiyet *</span>
        <select name="sex" required>
          <option value="F">Kadın (F)</option>
          <option value="M">Erkek (M)</option>
        </select>
      </label>
      <label class="field">
        <span>Kan Grubu</span>
        <select name="bloodType">
          <option value="">Bilinmiyor</option>
          <option value="A+">A Rh+</option>
          <option value="A-">A Rh-</option>
          <option value="B+">B Rh+</option>
          <option value="B-">B Rh-</option>
          <option value="AB+">AB Rh+</option>
          <option value="AB-">AB Rh-</option>
          <option value="0+">0 Rh+</option>
          <option value="0-">0 Rh-</option>
        </select>
      </label>
      <label class="field">
        <span>Telefon</span>
        <input name="phone" placeholder="+90 532 555 0101" />
      </label>
      ${formActions('Hastayı Kaydet')}
    </form>`,
    'HASTA KAYIT',
  );

  $('#form-new-patient')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      mrn: String(fd.get('mrn') || '').trim() || undefined,
      nationalId: String(fd.get('nationalId') || '').trim() || undefined,
      givenName: String(fd.get('givenName') || '').trim(),
      familyName: String(fd.get('familyName') || '').trim(),
      birthDate: String(fd.get('birthDate') || '').trim(),
      sex: String(fd.get('sex') || 'F'),
      bloodType: String(fd.get('bloodType') || '').trim() || undefined,
      phone: String(fd.get('phone') || '').trim() || undefined,
    };
    try {
      const created = await api('/api/patients', { method: 'POST', body: payload });
      closeModal();
      toast(`Hasta kaydı oluşturuldu: ${created.mrn || `${payload.givenName} ${payload.familyName}`}`);
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Hasta kaydedilemedi.', 'error');
    }
  });
}

function openNewEncounterModal(defaultPatientId, onDone) {
  const options = cachedPatients.map((p) => {
    const sel = String(p.id) === String(defaultPatientId) ? 'selected' : '';
    return `<option value="${esc(p.id)}" ${sel}>${esc(p.mrn)} — ${esc(p.givenName)} ${esc(p.familyName)}</option>`;
  }).join('');

  showModal(
    'Yeni Karşılaşma / Muayene Aç',
    `<form id="form-new-encounter" class="form-grid">
      <label class="field field-full">
        <span>Hasta Seçin *</span>
        <select name="patientId" required>${options}</select>
      </label>
      <label class="field">
        <span>Başvuru Türü *</span>
        <select name="encounterType" required>
          <option value="Outpatient">Poliklinik (Outpatient)</option>
          <option value="Emergency">Acil Servis (Emergency)</option>
          <option value="Inpatient">Yatış (Inpatient)</option>
        </select>
      </label>
      <label class="field field-full">
        <span>Başvuru Yakınması (Chief Complaint) *</span>
        <textarea name="chiefComplaint" rows="2" required placeholder="Örn: Ateş, öksürük ve nefes darlığı"></textarea>
      </label>
      ${formActions('Karşılaşma Oluştur')}
    </form>`,
    'KABUL / KARŞILAŞMA',
  );

  $('#form-new-encounter')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      patientId: Number(fd.get('patientId')),
      encounterType: String(fd.get('encounterType') || 'Outpatient'),
      chiefComplaint: String(fd.get('chiefComplaint') || '').trim(),
    };
    try {
      const created = await api('/api/encounters', { method: 'POST', body: payload });
      closeModal();
      toast(`Karşılaşma #${created.id || ''} açıldı.`);
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Karşılaşma oluşturulamadı.', 'error');
    }
  });
}

export async function renderPatients() {
  const canCreatePatient = hasRole('admin', 'doctor', 'registrar');
  const canCreateEncounter = hasRole('admin', 'doctor', 'nurse', 'registrar');

  const queryParam = currentQuery ? `?q=${encodeURIComponent(currentQuery)}` : '';
  const [patients, encounters] = await Promise.all([
    api(`/api/patients${queryParam}`),
    api('/api/encounters'),
  ]);

  cachedPatients = Array.isArray(patients) ? patients : [];
  const encounterList = Array.isArray(encounters) ? encounters : [];

  const actionsHtml = [
    canCreatePatient ? '<button type="button" id="btn-new-patient" class="btn btn-primary btn-sm">+ Yeni Hasta</button>' : '',
    canCreateEncounter ? '<button type="button" id="btn-new-encounter" class="btn btn-ghost btn-sm">+ Karşılaşma Aç</button>' : '',
  ].filter(Boolean).join('');

  const patientRows = cachedPatients.map((p) => {
    const fullName = `${p.givenName || ''} ${p.familyName || ''}`.trim() || p.name || '-';
    const sexVal = p.sex ?? p.gender;
    const allergyCount = Number(p.allergyCount ?? (Array.isArray(p.allergies) ? p.allergies.length : 0));
    const allergyList = Array.isArray(p.allergies)
      ? p.allergies.map((a) => (typeof a === 'string' ? a : (a.allergen || a.substance || ''))).filter(Boolean).join(', ')
      : (p.allergySummary || '');
    const allergyBadge = allergyCount > 0 || allergyList
      ? `<span class="badge badge-danger" title="${esc(allergyList || 'Alerji kayıtlı')}">⚠ ${esc(allergyList || `${allergyCount} Alerji`)}</span>`
      : '<span class="badge badge-neutral">Yok</span>';

    return `
      <tr>
        <td><strong>${esc(p.mrn || '-')}</strong></td>
        <td>
          <div class="cell-strong">${esc(fullName)}</div>
          <div class="table-sub">TCKN: ${esc(p.nationalId || '-')}</div>
        </td>
        <td>${esc(sexVal === 'M' ? 'Erkek' : sexVal === 'F' ? 'Kadın' : (sexVal || '-'))}</td>
        <td>${esc(dateOnly(p.birthDate))}</td>
        <td><span class="badge badge-info">${esc(p.bloodType || '-')}</span></td>
        <td>${allergyBadge}</td>
        <td>${esc(p.phone || '-')}</td>
        <td class="table-actions">
          <button type="button" class="btn btn-sm btn-primary" data-drawer-pid="${esc(p.id)}">360° EMR</button>
          ${canCreateEncounter ? `<button type="button" class="btn btn-sm btn-ghost" data-enc-pid="${esc(p.id)}">+ Muayene</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  const encounterRows = encounterList.slice(0, 12).map((enc) => {
    const pid = pick(enc, 'patientId');
    const patName = patientDisplayName(enc);
    return `
      <tr>
        <td><strong>#${esc(enc.id)}</strong></td>
        <td>${esc(patName)}</td>
        <td>${badge(pick(enc, 'encounterType') || 'Outpatient')}</td>
        <td>${esc(pick(enc, 'chiefComplaint') || '-')}</td>
        <td>${esc(pick(enc, 'medulaTakipNo') || '-')}</td>
        <td>${badge(pick(enc, 'status') || 'Open')}</td>
        <td>${esc(dateTime(pick(enc, 'openedAt', 'createdAt')))}</td>
        <td><button type="button" class="btn btn-sm btn-ghost" data-drawer-pid="${esc(pid)}">360° EMR</button></td>
      </tr>
    `;
  }).join('');

  return `
    ${heading('HASTA KABUL & EMR', 'Hasta Yönetimi', 'Hasta demografisi, alerji uyarıları, karşılaşma açılışı ve 360° EMR dosyası', actionsHtml)}

    <section class="panel">
      <form id="patient-search-form" class="toolbar-row">
        <input id="patient-search" class="toolbar-input" type="search" value="${esc(currentQuery)}" placeholder="MRN (ör. HB-000101), Ad, Soyad veya TCKN ara..." />
        <button type="submit" id="patient-search-btn" class="btn btn-primary btn-sm">Ara</button>
        ${currentQuery ? '<button type="button" id="patient-search-clear" class="btn btn-ghost btn-sm">Temizle</button>' : ''}
      </form>
      ${cachedPatients.length
        ? table(['MRN', 'Hasta / TCKN', 'Cinsiyet', 'Doğum Tarihi', 'Kan', 'Alerji CDS', 'Telefon', 'İşlemler'], patientRows)
        : empty('Arama kriterine uygun hasta bulunamadı.')}
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Aktif ve Son Karşılaşmalar</h2>
          <p class="panel-sub">Poliklinik, acil servis ve yatan hasta karşılaşmaları</p>
        </div>
      </div>
      ${encounterList.length
        ? table(['ID', 'Hasta', 'Tür', 'Yakınma', 'MEDULA Takip', 'Durum', 'Açılış', ''], encounterRows)
        : empty('Kayıtlı karşılaşma yok.')}
    </section>
  `;
}

export function bindPatientsEvents(container, { reload }) {
  if (!container) return;

  container.addEventListener('submit', async (e) => {
    if (e.target.id === 'patient-search-form') {
      e.preventDefault();
      currentQuery = ($('#patient-search')?.value || '').trim();
      await reload();
    }
  });

  container.addEventListener('click', async (e) => {
    if (e.target.closest('#patient-search-clear')) {
      currentQuery = '';
      await reload();
      return;
    }
    if (e.target.closest('#btn-new-patient')) {
      openNewPatientModal(reload);
      return;
    }
    if (e.target.closest('#btn-new-encounter')) {
      openNewEncounterModal(cachedPatients[0]?.id, reload);
      return;
    }
    const drawerBtn = e.target.closest('[data-drawer-pid]');
    if (drawerBtn) {
      await openPatientDrawer(drawerBtn.dataset.drawerPid);
      return;
    }
    const encBtn = e.target.closest('[data-enc-pid]');
    if (encBtn) {
      openNewEncounterModal(encBtn.dataset.encPid, reload);
    }
  });
}
