import { $, closeModal, empty, esc, initials, toast } from './js/dom.js';
import {
  NAV_ITEMS,
  PAGE_NAMES,
  ROLE_LABELS,
  canAccessPage,
  currentRole,
  state,
} from './js/state.js';
import {
  handleLoginFormSubmit,
  initAuth,
  loginDemo,
  logout,
  renderAuthModeChrome,
  setLoginError,
  switchDemoRole,
} from './js/auth.js';
import { initCommandPalette, openCommandPalette } from './js/components/command-palette.js';
import { closePatientDrawer } from './js/components/patient-drawer.js';
import {
  fetchSimState,
  initSimulation,
  isSimulationActive,
  showSimGuardModal,
  syncSimulationVisibility,
} from './js/simulation.js';
import { bindDashboardEvents, renderDashboard } from './js/views/dashboard.js';
import { bindPatientsEvents, renderPatients } from './js/views/patients.js';
import { bindClinicalEvents, renderClinical } from './js/views/clinical.js';
import { bindBedsEvents, renderBeds } from './js/views/beds.js';
import { bindPharmacyEvents, renderPharmacy } from './js/views/pharmacy.js';
import { bindBillingEvents, renderBilling } from './js/views/billing.js';
import { bindVaccinationsEvents, renderVaccinations } from './js/views/vaccinations.js';
import { bindConnectorsEvents, renderConnectors, setConnectorsTab } from './js/views/connectors.js';
import { bindIntegrationsEvents, renderIntegrations } from './js/views/integrations.js';
import { bindAuditEvents, renderAudit } from './js/views/audit.js';

const VIEWS = {
  dashboard: { render: renderDashboard, bind: bindDashboardEvents },
  patients: { render: renderPatients, bind: bindPatientsEvents },
  clinical: { render: renderClinical, bind: bindClinicalEvents },
  beds: { render: renderBeds, bind: bindBedsEvents },
  pharmacy: { render: renderPharmacy, bind: bindPharmacyEvents },
  billing: { render: renderBilling, bind: bindBillingEvents },
  vaccinations: { render: renderVaccinations, bind: bindVaccinationsEvents },
  connectors: { render: renderConnectors, bind: bindConnectorsEvents },
  integrations: { render: renderIntegrations, bind: bindIntegrationsEvents },
  audit: { render: renderAudit, bind: bindAuditEvents },
};

let renderSeq = 0;

function closeMobileSidebar() {
  $('#app-sidebar')?.classList.remove('is-open');
  $('#sidebar-backdrop')?.classList.add('hidden');
}

function resolvePageTarget(requestedPage) {
  let target = requestedPage || 'dashboard';
  if (target === 'mhrs') {
    setConnectorsTab('mhrs');
    target = 'connectors';
  } else if (target === 'ulak') {
    setConnectorsTab('ulak');
    target = 'connectors';
  }

  if (!VIEWS[target] || !canAccessPage(target)) {
    const firstAllowed = NAV_ITEMS.find(([id]) => canAccessPage(id));
    target = firstAllowed ? firstAllowed[0] : 'dashboard';
  }
  return target;
}

function renderNav() {
  const nav = $('#main-nav');
  if (!nav) return;

  const active = state.page || 'dashboard';
  nav.innerHTML = NAV_ITEMS
    .filter(([id]) => canAccessPage(id))
    .map(([id, icon, label]) => `
      <button type="button" data-page="${esc(id)}" class="nav-item ${id === active ? 'active' : ''}">
        <span class="nav-ico" aria-hidden="true">${esc(icon)}</span>
        <span>${esc(label)}</span>
      </button>
    `)
    .join('');
}

function renderUserChrome() {
  const user = state.user;
  if (!user) return;
  const role = currentRole();
  const roleLabel = ROLE_LABELS[role] || user.role || '-';
  const displayName = user.displayName || user.username || '-';

  if ($('#user-avatar')) $('#user-avatar').textContent = initials(displayName);
  if ($('#user-name')) $('#user-name').textContent = displayName;
  if ($('#user-role')) $('#user-role').textContent = roleLabel;
  if ($('#top-user-name')) $('#top-user-name').textContent = `${displayName} · ${roleLabel}`;
  if ($('#top-date')) {
    $('#top-date').textContent = new Date().toLocaleDateString('tr-TR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
  if ($('#sidebar-role-badge')) $('#sidebar-role-badge').textContent = role;
  if ($('#sidebar-role-select')) $('#sidebar-role-select').value = role;
  if ($('#demo-role-select')) $('#demo-role-select').value = role;

  renderAuthModeChrome();
  syncSimulationVisibility();
  renderNav();
}

async function renderCurrentPage() {
  const container = $('#page-content');
  if (!container || !state.user) return;

  const mySeq = ++renderSeq;
  const page = resolvePageTarget(state.page);
  state.page = page;
  renderNav();

  if ($('#page-crumb')) {
    $('#page-crumb').textContent = PAGE_NAMES[page] || page;
  }

  container.innerHTML = '<div class="loading-state">Yükleniyor...</div>';

  try {
    const view = VIEWS[page];
    const html = await view.render({ navigateTo });
    if (mySeq !== renderSeq) return;

    const viewRoot = document.createElement('div');
    viewRoot.className = 'view-root';
    viewRoot.innerHTML = html;
    container.replaceChildren(viewRoot);

    if (view.bind) {
      view.bind(viewRoot, {
        reload: renderCurrentPage,
        navigateTo,
      });
    }
  } catch (err) {
    if (mySeq !== renderSeq) return;
    const msg = err?.status === 403
      ? 'Bu bölümü görüntülemek için rol yetkiniz bulunmuyor.'
      : (err?.message || 'Sayfa yüklenirken bir hata oluştu.');
    container.innerHTML = empty('Veri Yüklenemedi', msg);
    toast(msg, 'error');
  }
}

async function navigateTo(requestedPage, { fromSimulation = false } = {}) {
  closeMobileSidebar();
  state.page = resolvePageTarget(requestedPage);
  if (!fromSimulation) {
    setLoginError('');
  }
  await renderCurrentPage();
}

async function enterAppShell(user) {
  if (!user) return;
  state.user = user;
  $('#login-screen')?.classList.add('hidden');
  $('#app-shell')?.classList.remove('hidden');

  initCommandPalette({ navigateTo });
  initSimulation({ navigateTo, renderCurrentPage });
  renderUserChrome();
  await navigateTo(state.page || 'dashboard');
  await fetchSimState();
}

function handleSessionLost(message) {
  closePatientDrawer();
  closeModal();
  $('#app-shell')?.classList.add('hidden');
  $('#login-screen')?.classList.remove('hidden');
  renderAuthModeChrome();
  if (message) setLoginError(message);
}

function bindGlobalEvents() {
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const user = await handleLoginFormSubmit();
      if (user) await enterAppShell(user);
    } catch (err) {
      setLoginError(err?.message || 'Giriş yapılamadı.');
    }
  });

  $('#quick-login-grid')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-demo-role]');
    if (!btn) return;
    try {
      const user = await loginDemo(btn.dataset.demoRole);
      await enterAppShell(user);
    } catch (err) {
      setLoginError(err?.message || 'Demo girişi başarısız.');
    }
  });

  const handleRoleChange = async (nextRole) => {
    try {
      const nextUser = await switchDemoRole(nextRole);
      if (nextUser) {
        closePatientDrawer();
        renderUserChrome();
        await navigateTo(state.page);
        toast(`Rol değiştirildi: ${ROLE_LABELS[nextUser.role] || nextUser.role}`);
      }
    } catch (err) {
      toast(err?.message || 'Rol değiştirilemedi.', 'error');
    }
  };

  $('#demo-role-select')?.addEventListener('change', (e) => handleRoleChange(e.target.value));
  $('#sidebar-role-select')?.addEventListener('change', (e) => handleRoleChange(e.target.value));

  $('#logout-btn')?.addEventListener('click', async () => {
    closePatientDrawer();
    closeModal();
    await logout();
  });

  $('#main-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (btn) navigateTo(btn.dataset.page);
  });

  $('#btn-open-search')?.addEventListener('click', () => openCommandPalette());

  $('#modal-close')?.addEventListener('click', closeModal);
  $('#modal')?.addEventListener('click', (e) => {
    if (e.target === $('#modal') || e.target.closest('[data-close]')) closeModal();
  });

  $('#btn-mobile-nav')?.addEventListener('click', () => {
    $('#app-sidebar')?.classList.toggle('is-open');
    $('#sidebar-backdrop')?.classList.toggle('hidden');
  });
  $('#sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);

  // Guard manual write triggers while live simulation is running
  $('#page-content')?.addEventListener(
    'click',
    (e) => {
      if (!isSimulationActive()) return;
      const mutatingBtn = e.target.closest(
        '[id^="btn-new-"], [id^="btn-add-"], [data-order-status], [data-dispense-rx], [data-pay-invoice], [data-clean-bed], [data-discharge-adm], [data-mhrs-admit], [data-ulak-admit], [data-retry-outbox]',
      );
      if (mutatingBtn) {
        e.preventDefault();
        e.stopPropagation();
        showSimGuardModal();
      }
    },
    true,
  );
}

async function bootstrap() {
  bindGlobalEvents();
  try {
    const authRes = await initAuth({ onSessionLost: handleSessionLost });
    if (authRes?.redirecting) return;
    if (authRes?.authenticated && authRes.user) {
      await enterAppShell(authRes.user);
    } else {
      handleSessionLost('');
    }
  } catch (err) {
    handleSessionLost(err?.message || 'Sistem başlatılırken bağlantı hatası oluştu.');
  }
}

bootstrap();
