import { api } from '../api.js';
import {
  $,
  badge,
  dateTime,
  empty,
  esc,
  heading,
  patientDisplayName,
  pick,
  table,
} from '../dom.js';
import { canAccessPage, hasRole } from '../state.js';
import { openPatientDrawer } from '../components/patient-drawer.js';

function gatewayEntries(gateways) {
  if (!gateways) return [];
  if (Array.isArray(gateways)) return gateways;
  return Object.entries(gateways).map(([key, val]) => ({
    key,
    ...(typeof val === 'object' && val ? val : { label: key, status: String(val || 'Online') }),
  }));
}

export async function renderDashboard({ navigateTo }) {
  const canViewConnectors = hasRole('admin', 'doctor', 'nurse', 'pharmacist', 'billing', 'registrar', 'integration');

  const [dash, overview] = await Promise.all([
    api('/api/dashboard'),
    canViewConnectors ? api('/api/connectors/overview').catch(() => null) : Promise.resolve(null),
  ]);

  const d = dash || {};
  const patientsCount = Number(d.patients ?? 0);
  const openEncounters = Number(d.openEncounters ?? 0);
  const ordersToday = Number(d.ordersToday ?? 0);
  const criticalResults = Number(d.criticalResults ?? 0);
  const occupiedBeds = Number(d.occupiedBeds ?? 0);
  const availableBeds = Number(d.availableBeds ?? 0);
  const totalBeds = occupiedBeds + availableBeds;
  const occupancyPct = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;
  const pendingPrescriptions = Number(d.pendingPrescriptions ?? 0);
  const pendingIntegrations = Number(d.pendingIntegrations ?? 0);
  const activeUlakCases = Number(d.activeUlakCases ?? 0);
  const todayMhrs = Number(d.todayMhrsAppointments ?? 0);

  const recentEncounters = Array.isArray(d.recentEncounters) ? d.recentEncounters : [];
  const gateways = gatewayEntries(overview?.gateways);

  const quickActions = [
    canAccessPage('patients') ? '<button type="button" class="btn btn-primary btn-sm" data-dash-nav="patients">Hasta Yönetimi</button>' : '',
    canAccessPage('clinical') ? '<button type="button" class="btn btn-ghost btn-sm" data-dash-nav="clinical">Klinik & İstemler</button>' : '',
    canAccessPage('connectors') ? '<button type="button" class="btn btn-ghost btn-sm" data-dash-nav="connectors">Ulusal Kapılar</button>' : '',
  ].filter(Boolean).join('');

  const encounterRows = recentEncounters.map((enc) => {
    const pid = pick(enc, 'patientId');
    const patientName = patientDisplayName(enc);
    const mrn = pick(enc, 'mrn') || '';
    const encType = pick(enc, 'encounterType', 'type') || '-';
    const complaint = pick(enc, 'chiefComplaint') || '-';
    const status = pick(enc, 'status') || 'Open';
    const openedAt = pick(enc, 'openedAt', 'createdAt');
    const drawerBtn = pid && (canAccessPage('patients') || canAccessPage('clinical') || canAccessPage('beds'))
      ? `<button type="button" class="btn btn-sm btn-ghost" data-open-drawer="${esc(pid)}">360° EMR</button>`
      : '';

    return `
      <tr>
        <td><strong>#${esc(enc.id)}</strong></td>
        <td>
          <div>${esc(patientName)}</div>
          ${mrn ? `<div class="table-sub">${esc(mrn)}</div>` : ''}
        </td>
        <td>${badge(encType)}</td>
        <td>${esc(complaint)}</td>
        <td>${badge(status)}</td>
        <td>${esc(dateTime(openedAt))}</td>
        <td>${drawerBtn}</td>
      </tr>
    `;
  }).join('');

  const gatewayCards = gateways.length
    ? `<div class="gateway-grid">${gateways.map((gw) => `
        <div class="gateway-card">
          <div class="gateway-card-head">
            <strong>${esc(gw.name || gw.label || gw.key?.toUpperCase())}</strong>
            ${badge(gw.status || 'Online')}
          </div>
          <div class="gateway-card-meta">
            <span>${esc(gw.endpoint || gw.protocol || 'REST / HL7')}</span>
            ${gw.latencyMs !== undefined ? `<span>${esc(gw.latencyMs)} ms</span>` : ''}
          </div>
        </div>
      `).join('')}</div>`
    : empty('Kapı telemetrisi görüntüleme yetkisi veya verisi yok.');

  return `
    ${heading('HASTANE KOMUTA MERKEZİ', 'Genel Bakış', 'Canlı klinik yoğunluk, yatak doluluğu ve ulusal entegrasyon özeti', quickActions)}

    <section class="kpi-grid">
      <article class="kpi-card">
        <span class="kpi-label">Kayıtlı Hasta</span>
        <strong class="kpi-value">${esc(patientsCount)}</strong>
        <span class="kpi-sub">Toplam aktif hasta profili</span>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Açık Karşılaşma</span>
        <strong class="kpi-value">${esc(openEncounters)}</strong>
        <span class="kpi-sub">MHRS Bugün: ${esc(todayMhrs)} · 112 Aktif: ${esc(activeUlakCases)}</span>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Bugünkü İstem</span>
        <strong class="kpi-value">${esc(ordersToday)}</strong>
        <span class="kpi-sub">Kritik Sonuç: <span class="${criticalResults > 0 ? 'text-danger' : ''}">${esc(criticalResults)}</span></span>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Yatak Doluluğu</span>
        <strong class="kpi-value">%${esc(occupancyPct)}</strong>
        <span class="kpi-sub">${esc(occupiedBeds)} dolu / ${esc(availableBeds)} boş yatak</span>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Bekleyen E-Reçete</span>
        <strong class="kpi-value">${esc(pendingPrescriptions)}</strong>
        <span class="kpi-sub">Eczane doğrulama ve teslim</span>
      </article>
      <article class="kpi-card">
        <span class="kpi-label">Bekleyen Outbox</span>
        <strong class="kpi-value">${esc(pendingIntegrations)}</strong>
        <span class="kpi-sub">Senkronizasyon kuyruğu</span>
      </article>
    </section>

    <div class="dashboard-split">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Son Klinik Karşılaşmalar</h2>
            <p class="panel-sub">Hasta 360° EMR özeti için satırdaki EMR düğmesini kullanın</p>
          </div>
        </div>
        ${recentEncounters.length
          ? table(['ID', 'Hasta', 'Tür', 'Yakınma', 'Durum', 'Açılış', ''], encounterRows)
          : empty('Kayıtlı karşılaşma bulunmuyor.')}
      </section>

      ${canViewConnectors ? `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Ulusal Sağlık Kapıları (Canlı Telemetri)</h2>
              <p class="panel-sub">Toplam trafik: ${esc(overview?.counts?.totalTrafficToday ?? 0)} · Bekleyen outbox: ${esc(overview?.counts?.pendingOutbox ?? pendingIntegrations)}</p>
            </div>
            ${canAccessPage('connectors') ? '<button type="button" class="btn btn-sm btn-ghost" data-dash-nav="connectors">Tüm Kapıları Aç →</button>' : ''}
          </div>
          ${gatewayCards}
        </section>
      ` : ''}
    </div>
  `;

  // Note: event handlers are bound via bindDashboardEvents exported below
}

export function bindDashboardEvents(container, { navigateTo }) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-dash-nav]');
    if (navBtn && navigateTo) {
      navigateTo(navBtn.dataset.dashNav);
      return;
    }
    const drawerBtn = e.target.closest('[data-open-drawer]');
    if (drawerBtn) {
      openPatientDrawer(drawerBtn.dataset.openDrawer);
    }
  });
}
