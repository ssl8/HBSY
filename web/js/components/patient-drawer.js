/**
 * Patient 360° EMR Slide-Over Drawer.
 * Displays patient allergies, active admissions, vitals + NEWS2 risk badge & SVG sparkline,
 * SOAP notes, orders, lab results (with critical read-back), radiology reports, prescriptions,
 * and role-gated quick forms (Record Vitals, Add SOAP Note, Create Order).
 */

import { api } from '../api.js';
import { $, badge, dateOnly, dateTime, empty, esc, toast } from '../dom.js';
import { computeNews2 } from '../news2.js';
import { hasRole, state } from '../state.js';
import { showDicomViewer } from './dicom-viewer.js';

let activePatientId = null;
let activeDrawerTab = 'overview';

function buildSparklineSvg(values, color = '#087e8b', label = '') {
  const nums = values.map(Number).filter(n => Number.isFinite(n));
  if (nums.length < 2) {
    return `<div class="sparkline-empty">${esc(label)}: ${nums.length === 1 ? esc(nums[0]) : '—'}</div>`;
  }
  const w = 150;
  const h = 38;
  const pad = 4;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const pts = nums
    .map((v, i) => {
      const x = pad + (i / (nums.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = nums[nums.length - 1];
  return `
    <div class="sparkline-card">
      <div class="sparkline-head">
        <span>${esc(label)}</span>
        <strong>${esc(last)}</strong>
      </div>
      <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" aria-hidden="true">
        <polyline fill="none" stroke="${esc(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />
      </svg>
    </div>
  `;
}

function renderAllergyPills(allergiesRaw) {
  const text = Array.isArray(allergiesRaw)
    ? allergiesRaw.join(', ')
    : String(allergiesRaw || '').trim();
  if (!text || text.toLowerCase() === 'yok' || text.toLowerCase() === 'none') {
    return '<span class="badge green">Bilinen İlaç Alerjisi Yok</span>';
  }
  return text
    .split(/[,;]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(token => `<span class="badge red">⚠ Alerji: ${esc(token)}</span>`)
    .join(' ');
}

let drawerGlobalListenersBound = false;

function ensureDrawerGlobalListeners() {
  if (drawerGlobalListenersBound) return;
  drawerGlobalListenersBound = true;
  $('#patient-360-backdrop')?.addEventListener('click', closePatientDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const drawer = $('#patient-360-drawer');
      if (drawer && !drawer.classList.contains('hidden')) {
        closePatientDrawer();
      }
    }
  });
}

export function closePatientDrawer() {
  const drawer = $('#patient-360-drawer');
  const backdrop = $('#patient-360-backdrop');
  if (drawer) {
    drawer.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
  }
  if (backdrop) backdrop.classList.add('hidden');
  activePatientId = null;
}

export async function openPatientDrawer(patientId, initialTab = 'overview') {
  ensureDrawerGlobalListeners();
  const drawer = $('#patient-360-drawer');
  const backdrop = $('#patient-360-backdrop');
  const body = $('#patient-360-body');
  if (!drawer || !body) return;

  activePatientId = Number(patientId);
  activeDrawerTab = initialTab;
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  if (backdrop) backdrop.classList.remove('hidden');
  body.innerHTML = '<div class="loading-state">Hasta 360° EMR dosyası yükleniyor…</div>';

  try {
    const chart = await api(`/api/patients/${activePatientId}/chart`);
    renderPatientChart(chart);
  } catch (err) {
    body.innerHTML = `<div class="notice"><strong>Dosya açılamadı:</strong> ${esc(err.message)}</div>`;
  }
}

function renderPatientChart(chart) {
  const body = $('#patient-360-body');
  if (!body) return;

  const p = chart.patient || {};
  const allergies = chart.allergies ?? p.allergies ?? p.allergy;
  const encounters = Array.isArray(chart.encounters) ? chart.encounters : [];
  const vitals = Array.isArray(chart.vitals) ? chart.vitals : [];
  const notes = Array.isArray(chart.clinicalNotes) ? chart.clinicalNotes : [];
  const orders = Array.isArray(chart.orders) ? chart.orders : [];
  const labResults = Array.isArray(chart.labResults) ? chart.labResults : [];
  const radiologyReports = Array.isArray(chart.radiologyReports) ? chart.radiologyReports : [];
  const prescriptions = Array.isArray(chart.prescriptions) ? chart.prescriptions : [];
  const activeAdmission = chart.activeAdmission || null;

  // Keep radiology reports cached for DICOM modal trigger
  for (const r of radiologyReports) {
    if (!state.radiologyReports.some(x => Number(x.id) === Number(r.id))) {
      state.radiologyReports.push({
        ...r,
        givenName: p.givenName,
        familyName: p.familyName,
        mrn: p.mrn
      });
    }
  }

  const latestVital = vitals[0] || null;
  const activeEncounters = encounters.filter(e => ['Open', 'Admitted'].includes(e.status));
  const defaultEncounterId = activeEncounters[0]?.id || encounters[0]?.id || '';
  const canRecordVitalsOrNotes = hasRole('admin', 'doctor', 'nurse') && activeEncounters.length > 0;
  const canCreateOrder = hasRole('admin', 'doctor') && activeEncounters.length > 0;

  const orderedVitalsChrono = [...vitals].reverse();
  const hrSeries = orderedVitalsChrono.map(v => v.heartRate);
  const spo2Series = orderedVitalsChrono.map(v => v.spo2);
  const sbpSeries = orderedVitalsChrono.map(v => v.systolicBp);
  const newsSeries = orderedVitalsChrono.map(v => v.news2Score);

  const encounterOptionsHtml = activeEncounters
    .map(e => `<option value="${esc(e.id)}">#${esc(e.id)} · ${esc(e.encounterType)} (${esc(e.status)})</option>`)
    .join('');

  body.innerHTML = `
    <div class="drawer-patient-banner">
      <div class="drawer-patient-title">
        <div class="panel-head-inline">
          <div class="section-kicker">HASTA 360° EMR · ${esc(p.mrn || '—')}</div>
          <button type="button" id="drawer-close-btn" class="icon-btn modal-close" aria-label="Kapat">×</button>
        </div>
        <h3>${esc(p.givenName)} ${esc(p.familyName)}</h3>
        <div class="drawer-patient-meta">
          <span>Doğum: ${dateOnly(p.birthDate)}</span>
          <span>Cinsiyet: ${esc(p.sex === 'F' ? 'Kadın' : p.sex === 'M' ? 'Erkek' : 'Belirtilmemiş')}</span>
          <span>Kan: ${esc(p.bloodType || '—')}</span>
          <span>Tel: ${esc(p.phone || '—')}</span>
        </div>
        <div class="drawer-allergy-strip">
          ${renderAllergyPills(allergies)}
          ${(() => {
            const chronicText = p.chronicConditions || p.chronic;
            return chronicText && chronicText !== 'Yok' ? `<span class="badge gray">Kronik: ${esc(chronicText)}</span>` : '';
          })()}
        </div>
      </div>

      ${activeAdmission ? `
        <div class="drawer-admission-strip">
          <strong>Aktif Yatış:</strong>
          <span>${esc(activeAdmission.ward)} · Oda ${esc(activeAdmission.room)} / Yatak ${esc(activeAdmission.bedNo)}</span>
          <span class="muted">(${dateTime(activeAdmission.admittedAt)})</span>
        </div>
      ` : ''}
    </div>

    <div class="drawer-tabs" role="tablist">
      <button type="button" class="drawer-tab ${activeDrawerTab === 'overview' ? 'active' : ''}" data-drawer-tab="overview">Özet & Vital/NEWS2</button>
      <button type="button" class="drawer-tab ${activeDrawerTab === 'notes' ? 'active' : ''}" data-drawer-tab="notes">SOAP Notları (${notes.length})</button>
      <button type="button" class="drawer-tab ${activeDrawerTab === 'orders' ? 'active' : ''}" data-drawer-tab="orders">İstem & Sonuçlar (${orders.length})</button>
      <button type="button" class="drawer-tab ${activeDrawerTab === 'rx' ? 'active' : ''}" data-drawer-tab="rx">Reçeteler (${prescriptions.length})</button>
    </div>

    <div class="drawer-tab-panel ${activeDrawerTab === 'overview' ? '' : 'hidden'}" data-drawer-panel="overview">
      <div class="drawer-vitals-summary">
        <div class="panel-head-inline">
          <h4>Son Vital Bulgular & NEWS2 Erken Uyarı Skoru</h4>
          ${latestVital
            ? `<div class="news2-pill-group">
                <span class="badge ${latestVital.news2Risk === 'HIGH' ? 'red' : (latestVital.news2Risk === 'MEDIUM' || latestVital.news2Risk === 'LOW_MEDIUM') ? 'amber' : 'green'}">NEWS2: ${esc(latestVital.news2Score)}</span>
                ${badge(latestVital.news2Risk)}
              </div>`
            : '<span class="muted small">Vital kaydı yok</span>'}
        </div>

        <div class="sparkline-grid">
          ${buildSparklineSvg(newsSeries, '#c44444', 'NEWS2 Skoru')}
          ${buildSparklineSvg(hrSeries, '#087e8b', 'Nabız (/dk)')}
          ${buildSparklineSvg(spo2Series, '#16845b', 'SpO2 (%)')}
          ${buildSparklineSvg(sbpSeries, '#b7791f', 'Sistolik KB')}
        </div>

        ${vitals.length ? `
          <div class="drawer-list">
            ${vitals.slice(0, 5).map(v => `
              <div class="drawer-list-row">
                <div>
                  <strong>TA: ${esc(v.systolicBp)}/${esc(v.diastolicBp)} mmHg · Nabız: ${esc(v.heartRate)} · SS: ${esc(v.respRate)} · Ateş: ${esc(v.tempC)}°C · SpO2: %${esc(v.spo2)} · AVPU: ${esc(v.consciousness)}</strong>
                  <span class="sub-cell">${esc(v.recordedBy || 'Hemşire')} · ${dateTime(v.recordedAt)}</span>
                </div>
                <div>${badge(v.news2Risk)} <span class="badge gray">Skor: ${esc(v.news2Score)}</span></div>
              </div>
            `).join('')}
          </div>
        ` : empty('Henüz vital bulgu kaydedilmemiş')}
      </div>

      ${canRecordVitalsOrNotes ? `
        <form id="drawer-vitals-form" class="drawer-action-card">
          <div class="drawer-form-head">
            <h4>+ Hızlı Vital Bulgu & NEWS2 Kaydı</h4>
            <div id="drawer-news2-preview">${badge('LOW')} <span class="badge gray">Skor: 0</span></div>
          </div>
          <div class="form-grid">
            <div class="field full">
              <label>Aktif Başvuru</label>
              <select name="encounterId" required>${encounterOptionsHtml}</select>
            </div>
            <div class="field"><label>Sistolik KB (mmHg)</label><input name="systolicBp" type="number" min="40" max="280" value="120" required></div>
            <div class="field"><label>Diyastolik KB (mmHg)</label><input name="diastolicBp" type="number" min="20" max="180" value="78" required></div>
            <div class="field"><label>Nabız (/dk)</label><input name="heartRate" type="number" min="20" max="240" value="78" required></div>
            <div class="field"><label>Solunum Sayısı (/dk)</label><input name="respRate" type="number" min="4" max="60" value="16" required></div>
            <div class="field"><label>Ateş (°C)</label><input name="tempC" type="number" step="0.1" min="30" max="44" value="36.7" required></div>
            <div class="field"><label>SpO2 (%)</label><input name="spo2" type="number" min="50" max="100" value="98" required></div>
            <div class="field full">
              <label>Bilinç (AVPU)</label>
              <select name="consciousness">
                <option value="A">A — Uyanık (Alert)</option>
                <option value="V">V — Sözel Uyarıya Yanıt (Verbal)</option>
                <option value="P">P — Ağrılı Uyarıya Yanıt (Pain)</option>
                <option value="U">U — Yanıtsız (Unresponsive)</option>
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit">Vital & NEWS2 Kaydet</button>
          </div>
        </form>
      ` : ''}

      <div class="drawer-section">
        <h4>Başvuru Geçmişi (${encounters.length})</h4>
        ${encounters.length ? `
          <div class="drawer-list">
            ${encounters.map(e => `
              <div class="drawer-list-row">
                <div>
                  <strong>#${esc(e.id)} · ${esc(e.encounterType)}</strong>
                  <span class="sub-cell">${esc(e.chiefComplaint || '—')} · ${dateTime(e.openedAt)}</span>
                </div>
                ${badge(e.status)}
              </div>
            `).join('')}
          </div>
        ` : empty('Başvuru bulunmuyor')}
      </div>
    </div>

    <div class="drawer-tab-panel ${activeDrawerTab === 'notes' ? '' : 'hidden'}" data-drawer-panel="notes">
      ${canRecordVitalsOrNotes ? `
        <form id="drawer-soap-form" class="drawer-action-card">
          <h4>+ SOAP Klinik İzlem Notu Ekle</h4>
          <div class="form-grid">
            <div class="field"><label>Başvuru</label><select name="encounterId" required>${encounterOptionsHtml}</select></div>
            <div class="field"><label>Not Türü</label>
              <select name="noteType">
                <option value="SOAP">SOAP Klinik Notu</option>
                <option value="PROGRESS">Klinik İzlem (Progress)</option>
                <option value="TRIAGE">Triyaj Değerlendirmesi</option>
                <option value="CONSULT">Konsültasyon Notu</option>
                <option value="DISCHARGE">Taburculuk / Epikriz</option>
              </select>
            </div>
            <div class="field full"><label>S (Subjektif — Şikayet & Öykü) *</label><textarea name="subjective" rows="2" required placeholder="Hastanın yakınmaları ve öyküsü"></textarea></div>
            <div class="field full"><label>O (Objektif — Fizik Muayene & Bulgular) *</label><textarea name="objective" rows="2" required placeholder="Fizik muayene ve laboratuvar bulguları"></textarea></div>
            <div class="field full"><label>A (Assessment — Değerlendirme / Ön Tanı) *</label><textarea name="assessment" rows="2" required placeholder="ICD-10 ve klinik değerlendirme"></textarea></div>
            <div class="field full"><label>P (Plan — Tedavi & İzlem Planı) *</label><textarea name="plan" rows="2" required placeholder="İstem, ilaç ve takip planı"></textarea></div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit">SOAP Notunu Kaydet</button>
          </div>
        </form>
      ` : ''}
      <div class="drawer-list">
        ${notes.length ? notes.map(n => `
          <div class="soap-card">
            <div class="soap-head">
              <span class="badge blue">${esc(n.noteType || 'SOAP')}</span>
              <strong>${esc(n.author || 'Klinisyen')}</strong>
              <span class="muted small">${dateTime(n.createdAt)}</span>
            </div>
            <div class="soap-grid">
              <div><b>S:</b> ${esc(n.subjective)}</div>
              <div><b>O:</b> ${esc(n.objective)}</div>
              <div><b>A:</b> ${esc(n.assessment)}</div>
              <div><b>P:</b> ${esc(n.plan)}</div>
            </div>
          </div>
        `).join('') : empty('Henüz SOAP notu eklenmemiş')}
      </div>
    </div>

    <div class="drawer-tab-panel ${activeDrawerTab === 'orders' ? '' : 'hidden'}" data-drawer-panel="orders">
      ${canCreateOrder ? `
        <form id="drawer-order-form" class="drawer-action-card">
          <h4>+ Hızlı Klinik İstem Oluştur</h4>
          <div class="form-grid">
            <div class="field"><label>Başvuru</label><select name="encounterId" required>${encounterOptionsHtml}</select></div>
            <div class="field"><label>Tür</label>
              <select name="orderType">
                <option value="LAB">Laboratuvar (LAB)</option>
                <option value="RAD">Radyoloji (RAD)</option>
                <option value="PROCEDURE">Girişimsel (PROCEDURE)</option>
                <option value="CONSULT">Konsültasyon (CONSULT)</option>
              </select>
            </div>
            <div class="field"><label>Kod</label><input name="code" value="700.120" required></div>
            <div class="field"><label>Açıklama *</label><input name="description" required placeholder="Tetkik veya konsültasyon açıklaması"></div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit">İstemi Oluştur</button>
          </div>
        </form>
      ` : ''}

      <div class="drawer-section">
        <h4>Klinik İstemler (${orders.length})</h4>
        <div class="drawer-list">
          ${orders.length ? orders.map(o => `
            <div class="drawer-list-row">
              <div>
                <strong>${esc(o.orderType)} · ${esc(o.description)}</strong>
                <span class="sub-cell">${esc(o.codeSystem || 'SUT')}: ${esc(o.code)} · ${dateTime(o.createdAt)}</span>
              </div>
              ${badge(o.status)}
            </div>
          `).join('') : empty('İstem yok')}
        </div>
      </div>

      <div class="drawer-section">
        <h4>Laboratuvar Sonuçları (${labResults.length})</h4>
        <div class="drawer-list">
          ${labResults.length ? labResults.map(r => {
            const isCrit = Boolean(r.criticalFlag || r.critical);
            return `
              <div class="drawer-list-row ${isCrit ? 'crit-row' : ''}">
                <div>
                  <strong>${esc(r.display)}: ${esc(r.value)} ${esc(r.unit || '')}</strong>
                  <span class="sub-cell">Ref: ${esc(r.referenceRange || '—')} · Bayrak: ${esc(r.flag)} · ${dateTime(r.resultedAt)}</span>
                  ${r.criticalAckBy ? `<span class="sub-cell">Read-Back Onayı: ${esc(r.criticalAckBy)} (${dateTime(r.criticalAckAt)})</span>` : ''}
                </div>
                <div class="drawer-row-actions">
                  ${isCrit ? '<span class="badge red">KRİTİK</span>' : badge(r.flag === 'N' ? 'Normal' : r.flag)}
                  ${isCrit && !r.criticalAckAt && hasRole('doctor', 'admin')
                    ? `<button class="btn btn-danger btn-sm" type="button" data-drawer-ack-lab="${esc(r.id)}">Kritik Okuma Onayı</button>`
                    : ''}
                </div>
              </div>
            `;
          }).join('') : empty('Laboratuvar sonucu yok')}
        </div>
      </div>

      <div class="drawer-section">
        <h4>Radyoloji Raporları (${radiologyReports.length})</h4>
        <div class="drawer-list">
          ${radiologyReports.length ? radiologyReports.map(r => `
            <div class="drawer-list-row">
              <div>
                <strong>${esc(r.description || 'Radyoloji İnceleme')}</strong>
                <span class="sub-cell">${esc(r.impression)}</span>
              </div>
              <button class="btn btn-light btn-sm" type="button" data-drawer-dicom="${esc(r.id)}">🩻 DICOM</button>
            </div>
          `).join('') : empty('Radyoloji raporu yok')}
        </div>
      </div>
    </div>

    <div class="drawer-tab-panel ${activeDrawerTab === 'rx' ? '' : 'hidden'}" data-drawer-panel="rx">
      <div class="drawer-list">
        ${prescriptions.length ? prescriptions.map(rx => `
          <div class="drawer-list-row">
            <div>
              <strong>RX-${esc(rx.id)} · ${esc(rx.prescribedBy)}</strong>
              <span class="sub-cell">${esc(rx.itemCount || rx.items?.length || 1)} kalem · ${dateTime(rx.createdAt)}</span>
            </div>
            ${badge(rx.status)}
          </div>
        `).join('') : empty('Reçete yok')}
      </div>
    </div>
  `;

  // Bind Drawer close & tab switching
  $('#drawer-close-btn', body)?.addEventListener('click', closePatientDrawer);

  body.querySelectorAll('[data-drawer-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      activeDrawerTab = tabBtn.dataset.drawerTab;
      body.querySelectorAll('[data-drawer-tab]').forEach(b => b.classList.toggle('active', b === tabBtn));
      body.querySelectorAll('[data-drawer-panel]').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.drawerPanel !== activeDrawerTab);
      });
    });
  });

  // Live NEWS2 preview inside drawer vitals form
  const vitalsForm = $('#drawer-vitals-form');
  if (vitalsForm) {
    const updatePreview = () => {
      const fd = new FormData(vitalsForm);
      const calc = computeNews2({
        systolicBp: fd.get('systolicBp'),
        diastolicBp: fd.get('diastolicBp'),
        heartRate: fd.get('heartRate'),
        respRate: fd.get('respRate'),
        tempC: fd.get('tempC'),
        spo2: fd.get('spo2'),
        consciousness: fd.get('consciousness')
      });
      const prev = $('#drawer-news2-preview');
      if (prev) prev.innerHTML = `${badge(calc.risk)} <span class="badge gray">Skor: ${esc(calc.score)}</span>`;
    };
    vitalsForm.addEventListener('input', updatePreview);
    vitalsForm.addEventListener('change', updatePreview);
    vitalsForm.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(vitalsForm);
      const encId = Number(fd.get('encounterId') || defaultEncounterId);
      try {
        await api(`/api/encounters/${encId}/vitals`, {
          method: 'POST',
          body: {
            systolicBp: Number(fd.get('systolicBp')),
            diastolicBp: Number(fd.get('diastolicBp')),
            heartRate: Number(fd.get('heartRate')),
            respRate: Number(fd.get('respRate')),
            tempC: Number(fd.get('tempC')),
            spo2: Number(fd.get('spo2')),
            consciousness: String(fd.get('consciousness') || 'A')
          }
        });
        toast('Vital bulgular ve NEWS2 skoru kaydedildi.', 'success');
        await openPatientDrawer(activePatientId, 'overview');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // SOAP note submission
  const soapForm = $('#drawer-soap-form');
  soapForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(soapForm);
    const encId = Number(fd.get('encounterId') || defaultEncounterId);
    try {
      await api(`/api/encounters/${encId}/notes`, {
        method: 'POST',
        body: {
          noteType: String(fd.get('noteType') || 'SOAP'),
          subjective: String(fd.get('subjective') || '').trim(),
          objective: String(fd.get('objective') || '').trim(),
          assessment: String(fd.get('assessment') || '').trim(),
          plan: String(fd.get('plan') || '').trim()
        }
      });
      toast('SOAP klinik notu kaydedildi.', 'success');
      await openPatientDrawer(activePatientId, 'notes');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Quick Order creation
  const orderForm = $('#drawer-order-form');
  orderForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(orderForm);
    const orderType = String(fd.get('orderType') || 'LAB');
    try {
      await api('/api/orders', {
        method: 'POST',
        body: {
          encounterId: Number(fd.get('encounterId') || defaultEncounterId),
          orderType,
          codeSystem: orderType === 'LAB' ? 'LOINC' : 'SUT',
          code: String(fd.get('code') || '700.120').trim(),
          description: String(fd.get('description') || '').trim(),
          priority: 'R'
        }
      });
      toast('Klinik istem oluşturuldu.', 'success');
      await openPatientDrawer(activePatientId, 'orders');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // DICOM button inside drawer
  body.querySelectorAll('[data-drawer-dicom]').forEach(btn => {
    btn.addEventListener('click', () => showDicomViewer(btn.dataset.drawerDicom));
  });

  // Critical lab acknowledge inside drawer
  body.querySelectorAll('[data-drawer-ack-lab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const labId = btn.dataset.drawerAckLab;
      try {
        await api(`/api/lab-results/${labId}/acknowledge`, {
          method: 'POST',
          body: {
            communicatedWith: state.user?.displayName || 'Klinisyen',
            ackNote: 'Patient 360° EMR üzerinden kritik değer okuma onayı verildi.'
          }
        });
        toast('Kritik laboratuvar okuma onayı kaydedildi.', 'success');
        await openPatientDrawer(activePatientId, 'orders');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}
