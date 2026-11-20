import { api } from './api.js';
import { $, toast } from './dom.js';
import { ROLE_LABELS, state } from './state.js';

const STEP_INTERVAL_MS = 4200;

let pollTimer = null;
let countdownTimer = null;
let countdownStart = 0;
let stepInFlight = false;
let initialized = false;

let callbacks = {
  navigateTo: null,
  renderCurrentPage: null,
};

function normalizeSimState(raw) {
  const s = raw?.state || raw || {};
  const status = s.status
    || (s.running && s.paused ? 'paused' : (s.running ? 'running' : 'stopped'));
  const stepIndex = Number(s.stepIndex ?? s.currentStepIndex ?? 0);
  const totalSteps = Number(s.totalSteps ?? 12);
  const history = Array.isArray(s.history) ? s.history : [];
  const currentStep = s.currentStep
    || s.step
    || s.event
    || s.lastExecutedStep
    || (history.length ? history[history.length - 1] : null);
  return {
    ...s,
    status,
    running: s.running ?? (status === 'running' || status === 'paused'),
    paused: s.paused ?? (status === 'paused'),
    stepIndex,
    totalSteps,
    currentStep,
  };
}

export function isSimulationEnabled() {
  return state.config?.features?.simulation === true;
}

export function isSimulationActive() {
  return isSimulationEnabled()
    && (state.sim?.status === 'running' || (state.sim?.running === true && !state.sim?.paused));
}

export function showSimGuardModal() {
  const modal = $('#sim-guard-modal');
  if (!modal) return;
  if (!modal.open) {
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  }
}

export function closeSimGuardModal() {
  const modal = $('#sim-guard-modal');
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) modal.close();
  else modal.removeAttribute('open');
}

function clearTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('hidden', !!hidden);
}

function startCountdownVisual() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownStart = Date.now();
  const fill = $('#sim-hud-countdown');
  const label = $('#sim-hud-timer-label');

  const tick = () => {
    const elapsed = Date.now() - countdownStart;
    const pct = Math.min(100, (elapsed / STEP_INTERVAL_MS) * 100);
    const remSec = Math.max(0, Math.ceil((STEP_INTERVAL_MS - elapsed) / 1000));
    if (fill) fill.style.width = `${pct}%`;
    if (label) label.textContent = remSec > 0 ? `Sonraki Adım: ${remSec}s` : 'İşleniyor...';
  };
  tick();
  countdownTimer = setInterval(tick, 120);
}

function applyHudStep(step, stepNum, totalSteps) {
  const badgeEl = $('#sim-hud-step-badge');
  const gatewayEl = $('#sim-hud-gateway');
  const iconEl = $('#sim-hud-icon');
  const actorEl = $('#sim-hud-actor');
  const deptEl = $('#sim-hud-dept');
  const textEl = $('#sim-hud-text');

  if (badgeEl) badgeEl.textContent = `ADIM ${stepNum} / ${totalSteps}`;
  if (!step) return;
  if (gatewayEl) gatewayEl.textContent = step.externalSystem || 'Kurumsal Entegrasyon';
  if (iconEl) iconEl.textContent = step.icon || '⚡';
  if (actorEl) actorEl.textContent = `Aktif Persona: ${ROLE_LABELS[step.role] || step.role || 'Admin'}`;
  if (deptEl) deptEl.textContent = `Birim: ${step.department || 'Hastane'}`;
  if (textEl) textEl.textContent = step.text || step.title || '';
}

export function syncSimulationVisibility() {
  const enabled = isSimulationEnabled() && Boolean(state.user);
  setHidden($('#sim-control-bar'), !enabled);
  setHidden($('#btn-toggle-sim'), !enabled);
  setHidden($('#btn-quick-reset'), !enabled);
  if (!enabled) {
    setHidden($('#sim-presentation-hud'), true);
    setHidden($('#sim-progress-track'), true);
    clearTimers();
  }
}

export function updateSimUI(simData) {
  syncSimulationVisibility();
  if (!isSimulationEnabled()) return;

  const s = normalizeSimState(simData || state.sim);
  state.sim = s;

  const dot = $('#sim-status-dot');
  const title = $('#sim-status-title');
  const sub = $('#sim-status-sub');
  const ticker = $('#sim-ticker-text');
  const btnPlay = $('#btn-sim-play');
  const btnPause = $('#btn-sim-pause');
  const btnStep = $('#btn-sim-step');
  const btnStop = $('#btn-sim-stop');
  const topSimBtn = $('#btn-toggle-sim');
  const hud = $('#sim-presentation-hud');
  const track = $('#sim-progress-track');
  const trackFill = $('#sim-progress-fill');
  const hudPause = $('#btn-hud-pause');
  const fill = $('#sim-hud-countdown');
  const timerLabel = $('#sim-hud-timer-label');

  const total = s.totalSteps || 12;
  const idx = s.stepIndex || 0;
  const currentStep = s.currentStep;
  const stepNum = Math.min(total, idx + 1);
  const pct = Math.min(100, Math.round((stepNum / total) * 100));

  if (s.status === 'running') {
    if (dot) dot.className = 'sim-pulse-dot running';
    if (title) title.textContent = `CANLI SİMÜLASYON ÇALIŞIYOR (${stepNum}/${total})`;
    if (sub) sub.textContent = 'Hastane içi birimler ve ulusal sağlık kapıları otomatik senkronize ediliyor';
    if (ticker) {
      ticker.textContent = currentStep?.text || currentStep?.title || 'Otomatik tur adımları yürütülüyor...';
    }
    setHidden(btnPlay, true);
    setHidden(btnPause, false);
    setHidden(btnStep, false);
    setHidden(btnStop, false);
    if (topSimBtn) topSimBtn.textContent = '⏸ Simülasyonu Duraklat';
    setHidden(track, false);
    if (trackFill) trackFill.style.width = `${pct}%`;
    setHidden(hud, false);
    applyHudStep(currentStep, stepNum, total);
    if (hudPause) hudPause.textContent = '⏸ Duraklat (Müdahale Et)';
    if (!countdownTimer) startCountdownVisual();
    return;
  }

  if (s.status === 'paused') {
    if (dot) dot.className = 'sim-pulse-dot paused';
    if (title) title.textContent = `SİMÜLASYON DURAKLATILDI (ADIM ${stepNum}/${total})`;
    if (sub) sub.textContent = 'Manuel müdahale modu aktif — tüm formları ve modülleri düzenleyebilirsiniz';
    if (ticker) {
      ticker.textContent = currentStep ? `Duraklatıldı: ${currentStep.title || currentStep.text}` : 'Simülasyon kullanıcı tarafından duraklatıldı.';
    }
    setHidden(btnPlay, false);
    if (btnPlay) btnPlay.textContent = '▶ Devam Et';
    setHidden(btnPause, true);
    setHidden(btnStep, false);
    setHidden(btnStop, false);
    if (topSimBtn) topSimBtn.textContent = '▶ Simülasyona Devam Et';
    setHidden(track, false);
    if (trackFill) trackFill.style.width = `${pct}%`;
    setHidden(hud, false);
    applyHudStep(currentStep, stepNum, total);
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (fill) fill.style.width = '100%';
    if (timerLabel) timerLabel.textContent = 'Duraklatıldı — Manuel Müdahale Modu';
    if (hudPause) hudPause.textContent = '▶ Simülasyona Devam Et';
    return;
  }

  if (dot) dot.className = 'sim-pulse-dot';
  if (title) title.textContent = 'HİBRİT DEMO MODU: HAZIR';
  if (sub) sub.textContent = 'Tüm hastane birimleri ve dış sistemler tam otomatik simülasyona hazır';
  if (ticker) {
    ticker.textContent = 'Simülasyonu başlatarak MHRS, MEDULA, Klinik, LİS, PACS, Eczane, Acil 112, Yatak ve e-Nabız döngüsünü canlı izleyin.';
  }
  setHidden(btnPlay, false);
  if (btnPlay) btnPlay.textContent = '▶ Simülasyonu Başlat';
  setHidden(btnPause, true);
  setHidden(btnStep, true);
  setHidden(btnStop, true);
  if (topSimBtn) topSimBtn.textContent = '⚡ Canlı Simülasyon';
  setHidden(track, true);
  if (trackFill) trackFill.style.width = '0%';
  setHidden(hud, true);
  clearTimers();
}

export async function fetchSimState() {
  if (!isSimulationEnabled() || !state.user) return null;
  try {
    const raw = await api('/api/simulation/state');
    const s = normalizeSimState(raw);
    updateSimUI(s);
    if (s.status === 'running' && !pollTimer) {
      pollTimer = setInterval(() => {
        if (!stepInFlight && isSimulationActive()) {
          stepSimulation();
        }
      }, STEP_INTERVAL_MS);
    }
    return s;
  } catch {
    return null;
  }
}

export async function startSimulation() {
  if (!isSimulationEnabled()) return null;
  try {
    const raw = await api('/api/simulation/start', { method: 'POST' });
    const s = normalizeSimState(raw);
    updateSimUI(s);
    clearTimers();
    startCountdownVisual();
    toast('Canlı sistem simülasyonu başlatıldı.');
    pollTimer = setInterval(() => {
      if (!stepInFlight && isSimulationActive()) {
        stepSimulation();
      }
    }, STEP_INTERVAL_MS);
    await stepSimulation();
    return s;
  } catch (err) {
    toast(err?.message || 'Simülasyon başlatılamadı.', 'error');
    return null;
  }
}

export async function pauseSimulation() {
  if (!isSimulationEnabled()) return null;
  clearTimers();
  try {
    const raw = await api('/api/simulation/pause', { method: 'POST' });
    const s = normalizeSimState(raw);
    updateSimUI(s);
    toast('Simülasyon duraklatıldı. Artık manuel müdahale edebilirsiniz.');
    return s;
  } catch (err) {
    toast(err?.message || 'Simülasyon duraklatılamadı.', 'error');
    return null;
  }
}

export async function stopSimulation() {
  if (!isSimulationEnabled()) return null;
  clearTimers();
  try {
    const raw = await api('/api/simulation/stop', { method: 'POST' });
    const s = normalizeSimState(raw);
    updateSimUI(s);
    toast('Simülasyon durduruldu.');
    return s;
  } catch (err) {
    toast(err?.message || 'Simülasyon durdurulamadı.', 'error');
    return null;
  }
}

export async function stepSimulation() {
  if (!isSimulationEnabled() || stepInFlight) return null;
  stepInFlight = true;
  try {
    const res = await api('/api/simulation/step', { method: 'POST' });
    const simState = normalizeSimState(res);
    const executed = res?.executedStep || res?.step || res?.event || simState.currentStep;
    updateSimUI({ ...simState, currentStep: executed || simState.currentStep });
    if (simState.status === 'running') {
      startCountdownVisual();
    }

    if (executed?.page && callbacks.navigateTo) {
      await callbacks.navigateTo(executed.page, { fromSimulation: true });
    } else if (callbacks.renderCurrentPage) {
      await callbacks.renderCurrentPage();
    }
    return res;
  } catch (err) {
    toast(err?.message || 'Simülasyon adımı yürütülemedi.', 'error');
    return null;
  } finally {
    stepInFlight = false;
  }
}

export async function resetDemoDatabase() {
  if (!isSimulationEnabled()) return;
  try {
    await stopSimulation();
    await api('/api/demo/reset', { method: 'POST' });
    toast('Demo veritabanı başlangıç durumuna sıfırlandı.');
    if (callbacks.renderCurrentPage) {
      await callbacks.renderCurrentPage();
    }
  } catch (err) {
    toast(err?.message || 'Demo sıfırlama başarısız.', 'error');
  }
}

export function initSimulation({ navigateTo, renderCurrentPage } = {}) {
  callbacks.navigateTo = navigateTo || callbacks.navigateTo;
  callbacks.renderCurrentPage = renderCurrentPage || callbacks.renderCurrentPage;
  syncSimulationVisibility();

  if (initialized) return;
  initialized = true;

  $('#btn-toggle-sim')?.addEventListener('click', () => {
    if (isSimulationActive()) pauseSimulation();
    else startSimulation();
  });
  $('#btn-sim-play')?.addEventListener('click', () => startSimulation());
  $('#btn-sim-pause')?.addEventListener('click', () => pauseSimulation());
  $('#btn-sim-step')?.addEventListener('click', () => stepSimulation());
  $('#btn-sim-stop')?.addEventListener('click', () => stopSimulation());

  $('#btn-hud-pause')?.addEventListener('click', () => {
    if (isSimulationActive()) pauseSimulation();
    else startSimulation();
  });
  $('#btn-hud-step')?.addEventListener('click', () => stepSimulation());
  $('#btn-hud-stop')?.addEventListener('click', () => stopSimulation());

  $('#sim-guard-close')?.addEventListener('click', closeSimGuardModal);
  $('#sim-guard-resume')?.addEventListener('click', closeSimGuardModal);
  $('#sim-guard-pause-btn')?.addEventListener('click', async () => {
    closeSimGuardModal();
    await pauseSimulation();
  });
  $('#sim-guard-stop-btn')?.addEventListener('click', async () => {
    closeSimGuardModal();
    await stopSimulation();
  });
  $('#sim-guard-modal')?.addEventListener('click', (e) => {
    if (e.target === $('#sim-guard-modal')) closeSimGuardModal();
  });

  $('#btn-quick-reset')?.addEventListener('click', () => resetDemoDatabase());
}
