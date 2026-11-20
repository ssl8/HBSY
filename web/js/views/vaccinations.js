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
  showModal,
  table,
  toast,
} from '../dom.js';
import { hasRole } from '../state.js';

let cachedPatients = [];

function openNewVaccinationModal(onDone) {
  if (!cachedPatients.length) {
    toast('Hasta listesi yüklenemedi.', 'warning');
    return;
  }

  const options = cachedPatients.map((p) => `
    <option value="${esc(p.id)}">${esc(p.mrn)} — ${esc(p.givenName)} ${esc(p.familyName)}</option>
  `).join('');

  showModal(
    'Aşı Uygulama Kaydı (ATS / Halk Sağlığı)',
    `<form id="form-new-vaccine" class="form-grid">
      <label class="field field-full">
        <span>Hasta *</span>
        <select name="patientId" required>${options}</select>
      </label>
      <label class="field">
        <span>Aşı Kodu (ATS / CVX) *</span>
        <input name="vaccineCode" required value="FLU-2026" />
      </label>
      <label class="field">
        <span>Aşı Adı *</span>
        <input name="vaccineName" required value="Mevsimsel İnfluenza Aşısı (Tetravalan)" />
      </label>
      <label class="field">
        <span>Doz No *</span>
        <input type="number" name="doseNo" required min="1" max="10" value="1" />
      </label>
      <label class="field">
        <span>ATS Karekod / Lot No</span>
        <input name="lotNo" value="ATS-LOT-2026-041" />
      </label>
      ${formActions('Aşıyı Kaydet')}
    </form>`,
    'HALK SAĞLIĞI / AŞI',
  );

  $('#form-new-vaccine')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/vaccinations', {
        method: 'POST',
        body: {
          patientId: Number(fd.get('patientId')),
          vaccineCode: String(fd.get('vaccineCode') || '').trim(),
          vaccineName: String(fd.get('vaccineName') || '').trim(),
          doseNo: Number(fd.get('doseNo') || 1),
          lotNo: String(fd.get('lotNo') || '').trim() || undefined,
        },
      });
      closeModal();
      toast('Aşı uygulaması kaydedildi ve halk sağlığı bildirimi eklendi.');
      if (onDone) await onDone();
    } catch (err) {
      toast(err?.message || 'Aşı kaydedilemedi.', 'error');
    }
  });
}

export async function renderVaccinations() {
  const canCreate = hasRole('admin', 'doctor', 'nurse');
  const [vaccinations, patients] = await Promise.all([
    api('/api/vaccinations'),
    canCreate ? api('/api/patients').catch(() => []) : Promise.resolve([]),
  ]);

  const list = Array.isArray(vaccinations) ? vaccinations : [];
  cachedPatients = Array.isArray(patients) ? patients : [];

  const rows = list.map((v) => `
    <tr>
      <td><strong>#${esc(v.id)}</strong></td>
      <td>${esc(patientDisplayName(v))}</td>
      <td><span class="badge badge-info">${esc(v.vaccineCode || '-')}</span></td>
      <td><strong>${esc(v.vaccineName || '-')}</strong></td>
      <td>Doz ${esc(v.doseNo ?? 1)}</td>
      <td>${esc(v.lotNo || '-')}</td>
      <td>${esc(v.administeredBy || '-')}</td>
      <td>${esc(dateTime(v.administeredAt || v.createdAt))}</td>
    </tr>
  `).join('');

  const actions = canCreate
    ? '<button type="button" id="btn-new-vaccine" class="btn btn-primary btn-sm">+ Aşı Uygula</button>'
    : '';

  return `
    ${heading('HALK SAĞLIĞI & ATS', 'Aşılar & İmmünizasyon', 'Aşı Takip Sistemi (ATS) lot doğrulama ve bağışıklama kayıtları', actions)}

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Uygulanan Aşılar</h2>
          <p class="panel-sub">Hasta kayıtlarına işlenen dozlar e-Nabız / USS ile senkronize edilir</p>
        </div>
      </div>
      ${list.length
        ? table(['ID', 'Hasta', 'Aşı Kodu', 'Aşı Adı', 'Doz', 'Lot / ATS', 'Uygulayan', 'Tarih'], rows)
        : empty('Henüz aşı kaydı bulunmuyor.')}
    </section>
  `;
}

export function bindVaccinationsEvents(container, { reload }) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    if (e.target.closest('#btn-new-vaccine')) {
      openNewVaccinationModal(reload);
    }
  });
}
