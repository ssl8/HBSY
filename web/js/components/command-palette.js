import { api } from '../api.js';
import { $, $$, esc, toast } from '../dom.js';
import { NAV_ITEMS, PAGE_NAMES, canAccessPage, state } from '../state.js';
import { openPatientDrawer } from './patient-drawer.js';

const TYPE_LABELS = {
  page: 'SAYFA',
  patient: 'HASTA',
  encounter: 'KARŞILAŞMA',
  order: 'İSTEM',
  drug: 'İLAÇ',
  bed: 'YATAK',
};

let navigateCallback = null;
let initialized = false;
let debounceTimer = null;
let activeItems = [];
let activeIndex = 0;

function ensureDialogMarkup(dlg) {
  if (!dlg || dlg.dataset.ready === '1') return;
  dlg.innerHTML = `
    <div class="cp-shell">
      <div class="cp-header">
        <span class="cp-icon" aria-hidden="true">⌘</span>
        <input id="cp-input" class="cp-input" type="search" autocomplete="off" placeholder="Hasta, protokol, istem, ilaç, yatak veya sayfa ara..." aria-label="Hızlı Arama" />
        <kbd class="cp-kbd">ESC</kbd>
        <button type="button" id="cp-close" class="btn btn-sm btn-ghost" aria-label="Kapat">✕</button>
      </div>
      <div id="cp-results" class="cp-results" role="listbox"></div>
      <div class="cp-footer">
        <span><kbd>↑</kbd> <kbd>↓</kbd> Gezin</span>
        <span><kbd>Enter</kbd> Aç</span>
        <span><kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> Hızlı Arama</span>
      </div>
    </div>
  `;
  dlg.dataset.ready = '1';
}

function getFilteredNavItems(query) {
  const q = query.trim().toLocaleLowerCase('tr-TR');
  return NAV_ITEMS
    .filter(([page]) => canAccessPage(page))
    .map(([page, icon, label]) => ({
      type: 'page',
      id: page,
      page,
      title: `${icon} ${PAGE_NAMES[page] || label}`,
      subtitle: 'Modüle geç',
    }))
    .filter((item) => !q || item.title.toLocaleLowerCase('tr-TR').includes(q));
}

function renderResults(query, remoteItems, loading = false, errorMsg = '') {
  const resultsEl = $('#cp-results');
  if (!resultsEl) return;

  const navMatches = getFilteredNavItems(query);
  const filteredRemote = (remoteItems || []).filter((item) => {
    if (item.page && !canAccessPage(item.page)) {
      if (item.type === 'patient' && (canAccessPage('clinical') || canAccessPage('beds'))) {
        return true;
      }
      return false;
    }
    return true;
  });

  activeItems = [...filteredRemote, ...navMatches];
  if (activeIndex >= activeItems.length) activeIndex = 0;

  if (loading && !activeItems.length) {
    resultsEl.innerHTML = `<div class="cp-empty">Aranıyor...</div>`;
    return;
  }

  if (errorMsg && !activeItems.length) {
    resultsEl.innerHTML = `<div class="cp-empty">${esc(errorMsg)}</div>`;
    return;
  }

  if (!activeItems.length) {
    resultsEl.innerHTML = `<div class="cp-empty">Eşleşen kayıt veya sayfa bulunamadı.</div>`;
    return;
  }

  resultsEl.innerHTML = activeItems.map((item, idx) => {
    const typeKey = String(item.type || 'page').toLowerCase();
    const typeLabel = TYPE_LABELS[typeKey] || typeKey.toUpperCase();
    return `
      <button type="button" class="cp-item ${idx === activeIndex ? 'is-active' : ''}" data-cp-idx="${idx}" role="option" aria-selected="${idx === activeIndex ? 'true' : 'false'}">
        <span class="cp-item-type cp-type-${esc(typeKey)}">${esc(typeLabel)}</span>
        <span class="cp-item-main">
          <span class="cp-item-title">${esc(item.title || '-')}</span>
          ${item.subtitle ? `<span class="cp-item-sub">${esc(item.subtitle)}</span>` : ''}
        </span>
      </button>
    `;
  }).join('');
}

function updateActiveSelection() {
  const buttons = $$('#cp-results .cp-item');
  buttons.forEach((btn, idx) => {
    const selected = idx === activeIndex;
    btn.classList.toggle('is-active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) {
      btn.scrollIntoView({ block: 'nearest' });
    }
  });
}

async function runSearch(query) {
  const q = query.trim();
  if (!q) {
    renderResults('', []);
    return;
  }
  renderResults(q, [], true);
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const items = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);
    // Discard stale search responses if query changed while in flight
    const input = $('#cp-input');
    if (input && input.value.trim() !== q) return;
    renderResults(q, items, false);
  } catch (err) {
    renderResults(q, [], false, err?.message || 'Arama başarısız.');
  }
}

async function activateItem(item) {
  if (!item) return;
  closeCommandPalette();

  const type = String(item.type || '').toLowerCase();
  if (type === 'page' && item.page) {
    if (canAccessPage(item.page) && navigateCallback) {
      navigateCallback(item.page);
    }
    return;
  }

  if (type === 'patient') {
    const pid = item.patientId || item.id;
    if (canAccessPage('patients') && navigateCallback) {
      navigateCallback('patients');
    } else if (canAccessPage('clinical') && navigateCallback) {
      navigateCallback('clinical');
    }
    if (pid && (canAccessPage('patients') || canAccessPage('clinical') || canAccessPage('beds'))) {
      await openPatientDrawer(pid);
    } else {
      toast('Bu hasta kaydını açma yetkiniz yok.', 'error');
    }
    return;
  }

  if (type === 'encounter') {
    if (canAccessPage('clinical') && navigateCallback) {
      navigateCallback('clinical');
    } else if (canAccessPage('patients') && navigateCallback) {
      navigateCallback('patients');
    }
    if (item.patientId && (canAccessPage('patients') || canAccessPage('clinical') || canAccessPage('beds'))) {
      await openPatientDrawer(item.patientId);
    }
    return;
  }

  if (type === 'order') {
    if (canAccessPage('clinical') && navigateCallback) {
      navigateCallback('clinical');
    } else {
      toast('Klinik istemler modülüne erişim yetkiniz yok.', 'error');
    }
    return;
  }

  if (type === 'drug') {
    if (canAccessPage('pharmacy') && navigateCallback) {
      navigateCallback('pharmacy');
    } else {
      toast('Eczane modülüne erişim yetkiniz yok.', 'error');
    }
    return;
  }

  if (type === 'bed') {
    if (canAccessPage('beds') && navigateCallback) {
      navigateCallback('beds');
    } else {
      toast('Yatak / Yatış modülüne erişim yetkiniz yok.', 'error');
    }
    return;
  }

  if (item.page && canAccessPage(item.page) && navigateCallback) {
    navigateCallback(item.page);
  }
}

export function openCommandPalette() {
  if (!state.user) return;
  const dlg = $('#command-palette');
  if (!dlg) return;
  ensureDialogMarkup(dlg);

  const input = $('#cp-input');
  activeIndex = 0;
  if (input) input.value = '';
  renderResults('', []);

  if (!dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  input?.focus();
}

export function closeCommandPalette() {
  const dlg = $('#command-palette');
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}

export function initCommandPalette({ navigateTo } = {}) {
  navigateCallback = navigateTo || navigateCallback;
  const dlg = $('#command-palette');
  if (dlg) ensureDialogMarkup(dlg);

  if (initialized) return;
  initialized = true;

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (!state.user) return;
      e.preventDefault();
      if (dlg?.open) closeCommandPalette();
      else openCommandPalette();
    }
  });

  if (!dlg) return;

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('#cp-close')) {
      closeCommandPalette();
      return;
    }
    const itemBtn = e.target.closest('[data-cp-idx]');
    if (itemBtn) {
      const idx = Number(itemBtn.dataset.cpIdx);
      activateItem(activeItems[idx]);
    }
  });

  dlg.addEventListener('input', (e) => {
    if (e.target.id !== 'cp-input') return;
    activeIndex = 0;
    clearTimeout(debounceTimer);
    const val = e.target.value;
    debounceTimer = setTimeout(() => {
      runSearch(val);
    }, 140);
  });

  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (!activeItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % activeItems.length;
      updateActiveSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + activeItems.length) % activeItems.length;
      updateActiveSelection();
    } else if (e.key === 'Enter') {
      if (document.activeElement?.id === 'cp-input' || document.activeElement?.closest('#cp-results')) {
        e.preventDefault();
        activateItem(activeItems[activeIndex]);
      }
    }
  });
}
