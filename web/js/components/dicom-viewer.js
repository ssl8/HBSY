/**
 * Modality-aware interactive PACS DICOM Viewer on HTML5 Canvas.
 * Supports CR, CT, MR, US procedural medical phantoms, real Window/Level LUT,
 * slice navigation (CT/MR), pointer zoom/pan, invert, and calibrated mm ruler.
 */

import { $, esc, showModal } from '../dom.js';
import { state } from '../state.js';

const BASE_SIZE = 360;

const MODALITY_PRESETS = {
  CR: {
    label: 'Digital Radiography (CR)',
    defaultW: 320,
    defaultL: 145,
    minW: 60,
    maxW: 600,
    minL: 20,
    maxL: 240,
    kvp: '125 kV',
    ma: '320 mAs',
    pxSpacingMm: 0.72,
    slices: 1,
    thickness: 'PA Chest'
  },
  CT: {
    label: 'Computed Tomography (CT)',
    defaultW: 350,
    defaultL: 120,
    minW: 80,
    maxW: 800,
    minL: 10,
    maxL: 240,
    kvp: '120 kV',
    ma: '250 mA',
    pxSpacingMm: 0.48,
    slices: 24,
    thickness: '2.5 mm'
  },
  MR: {
    label: 'Magnetic Resonance (MR T2/FLAIR)',
    defaultW: 260,
    defaultL: 130,
    minW: 60,
    maxW: 500,
    minL: 20,
    maxL: 230,
    kvp: '1.5T TSE',
    ma: 'TE 98 / TR 4200',
    pxSpacingMm: 0.35,
    slices: 20,
    thickness: '3.0 mm'
  },
  US: {
    label: 'Ultrasound (US Sector)',
    defaultW: 240,
    defaultL: 125,
    minW: 60,
    maxW: 450,
    minL: 20,
    maxL: 230,
    kvp: '7.5 MHz Linear/Convex',
    ma: 'MI 1.1 | TIS 0.4',
    pxSpacingMm: 0.28,
    slices: 1,
    thickness: '14 cm Depth'
  }
};

function detectModality(report) {
  const explicit = String(report?.modality || '').toUpperCase();
  if (MODALITY_PRESETS[explicit]) return explicit;
  const desc = `${report?.description || ''} ${report?.code || ''}`.toUpperCase();
  if (desc.includes('BT') || desc.includes('CT') || desc.includes('TOMOGRAF')) return 'CT';
  if (desc.includes('MR') || desc.includes('REZONANS')) return 'MR';
  if (desc.includes('USG') || desc.includes('ULTRASON') || desc.includes('DOPPLER')) return 'US';
  return 'CR';
}

function deterministicNoise(x, y, seed = 1) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function ellipseDist(px, py, cx, cy, rx, ry, rot = 0) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = px - cx;
  const dy = py - cy;
  const tx = dx * cos + dy * sin;
  const ty = -dx * sin + dy * cos;
  return (tx * tx) / (rx * rx) + (ty * ty) / (ry * ry);
}

/** Synthesize normalized 0..255 anatomical scalar field for a given modality & slice. */
function buildPhantomField(modality, sliceIdx, totalSlices) {
  const field = new Uint8Array(BASE_SIZE * BASE_SIZE);
  const cx = BASE_SIZE / 2;
  const cy = BASE_SIZE / 2;
  const sliceNorm = totalSlices > 1 ? (sliceIdx - 1) / (totalSlices - 1) : 0.5;

  for (let y = 0; y < BASE_SIZE; y++) {
    for (let x = 0; x < BASE_SIZE; x++) {
      let val = 8;
      const nx = x - cx;
      const ny = y - cy;
      const noise = (deterministicNoise(x, y, sliceIdx) - 0.5) * 8;

      if (modality === 'CR') {
        // PA Chest X-ray phantom: ribs, clavicles, lung fields, mediastinum, heart, diaphragm
        const thorax = ellipseDist(x, y, cx, cy + 5, 132, 146);
        if (thorax < 1.05) {
          val = 72; // soft tissue
          // Spine column
          if (Math.abs(nx) < 16 && y > 24 && y < 332) {
            val += 76 * (1 - Math.abs(nx) / 18);
          }
          // Tracheal air lucency
          if (Math.abs(nx) < 8 && y > 26 && y < 140) {
            val -= 42;
          }
          // Lung fields (dark radiolucent air)
          const leftLung = ellipseDist(x, y, cx - 54, cy - 12, 49, 98, -0.06);
          const rightLung = ellipseDist(x, y, cx + 56, cy - 14, 51, 100, 0.06);
          if (leftLung < 1 || rightLung < 1) {
            const lungDepth = 1 - Math.min(leftLung, rightLung);
            val = 28 + 20 * (1 - lungDepth);
            // Pulmonary vascular branching
            const branch = Math.sin((nx * 0.14) + Math.cos(ny * 0.09) * 2.2);
            if (Math.abs(nx) < 62 && branch > 0.72) val += 24;
          }
          // Posterior ribs (arcing bands)
          for (let r = 0; r < 9; r++) {
            const ribY = 66 + r * 24 + (nx * nx) * 0.0028;
            const dRib = Math.abs(y - ribY);
            if (dRib < 5.5 && Math.abs(nx) > 14 && Math.abs(nx) < 126) {
              val += 48 * (1 - dRib / 5.5);
            }
          }
          // Clavicles
          const clavY = 68 - Math.abs(nx) * 0.18;
          if (Math.abs(nx) > 16 && Math.abs(nx) < 110 && Math.abs(y - clavY) < 5) {
            val += 64;
          }
          // Cardiac silhouette (shifted left-of-patient = screen right)
          const heart = ellipseDist(x, y, cx + 28, cy + 32, 46, 56, 0.25);
          if (heart < 1) {
            val = Math.max(val, 168 * (1 - heart * 0.35));
          }
          // Diaphragm domes
          const leftDome = 276 + Math.pow((nx + 64) / 72, 2) * 34;
          const rightDome = 282 + Math.pow((nx - 64) / 72, 2) * 34;
          if ((nx <= 0 && y > leftDome) || (nx > 0 && y > rightDome)) {
            val = Math.max(val, 152);
          }
        }
      } else if (modality === 'CT') {
        // Axial Thorax/Brain CT depending on slice position
        const body = ellipseDist(x, y, cx, cy, 138, 118);
        if (body < 1) {
          val = 85; // muscle / soft tissue
          // Subcutaneous rim
          if (body > 0.86) val = 48;
          // Vertebral body posteriorly
          const vert = ellipseDist(x, y, cx, cy + 78, 22, 18);
          if (vert < 1) val = 235;
          // Sternum anteriorly
          const stern = ellipseDist(x, y, cx, cy - 98, 16, 8);
          if (stern < 1) val = 220;
          // Lung windows (morphing with sliceIdx)
          const lungScale = 0.72 + Math.sin(sliceNorm * Math.PI) * 0.35;
          const lLung = ellipseDist(x, y, cx - 54, cy + 4, 48 * lungScale, 68 * lungScale, 0.15);
          const rLung = ellipseDist(x, y, cx + 54, cy + 4, 48 * lungScale, 68 * lungScale, -0.15);
          if (lLung < 1 || rLung < 1) {
            val = 20 + Math.max(0, Math.sin(x * 0.22) * Math.cos(y * 0.22)) * 14;
            // Small trauma contusion opacity in mid slices (matches seed CT report!)
            if (sliceNorm > 0.35 && sliceNorm < 0.7) {
              const lesion = ellipseDist(x, y, cx + 52, cy + 28, 16, 13);
              if (lesion < 1) val += 58 * (1 - lesion);
            }
          }
          // Heart / Mediastinal great vessels
          const medScale = 0.65 + sliceNorm * 0.45;
          const heart = ellipseDist(x, y, cx + 10, cy - 18, 36 * medScale, 40 * medScale, -0.2);
          if (heart < 1) val = 138;
          const aorta = ellipseDist(x, y, cx - 10, cy + 46, 13, 13);
          if (aorta < 1) val = 175;
          // Rib cross-sections around perimeter
          for (let a = 0; a < 14; a++) {
            const ang = (a / 14) * Math.PI * 2;
            const rx = cx + Math.cos(ang) * 124;
            const ry = cy + Math.sin(ang) * 102;
            if (ellipseDist(x, y, rx, ry, 7, 5, ang) < 1) val = 240;
          }
        }
      } else if (modality === 'MR') {
        // MRI T2/FLAIR Knee / Spine sagittal/axial contrast (high signal fluid, dark cortex)
        const outline = ellipseDist(x, y, cx, cy, 112, 136);
        if (outline < 1) {
          val = 76; // soft tissue
          const sliceOffset = (sliceNorm - 0.5) * 28;
          // Femoral / vertebral condyles with bright marrow & dark cortical rim
          const upperBone = ellipseDist(x, y, cx + sliceOffset * 0.4, cy - 58, 52, 48);
          const lowerBone = ellipseDist(x, y, cx + sliceOffset * 0.4, cy + 62, 50, 52);
          if (upperBone < 1) val = upperBone > 0.82 ? 16 : 132;
          if (lowerBone < 1) val = lowerBone > 0.82 ? 16 : 128;
          // Articular cartilage & T2 hyperintense joint fluid
          if (Math.abs(y - (cy + 4)) < 11 && Math.abs(nx) < 58) {
            val = 225 - Math.abs(y - (cy + 4)) * 8;
          }
          // Meniscal wedge (hypointense triangle with small Grade 2B hyperintense tear line)
          if (Math.abs(y - (cy + 4)) < 9 && Math.abs(nx - 34) < 18) {
            val = 22;
            if (Math.abs((y - cy) - (nx - 34) * 0.25) < 1.8) val = 205;
          }
          // Patella anteriorly
          const patella = ellipseDist(x, y, cx - 72, cy - 12, 18, 28, -0.15);
          if (patella < 1) val = patella > 0.78 ? 18 : 136;
          // Posterior neurovascular / popliteal fat
          const fat = ellipseDist(x, y, cx + 64, cy, 24, 66);
          if (fat < 1) val = Math.max(val, 155);
        }
      } else if (modality === 'US') {
        // Sector ultrasound cone with speckle, acoustic depth attenuation, and focal thyroid/vascular nodules
        const originY = 26;
        const dy = y - originY;
        const dist = Math.hypot(nx, dy);
        const angle = Math.atan2(nx, dy);
        const maxAngle = 0.62;
        if (dy > 18 && dist < 310 && Math.abs(angle) < maxAngle) {
          const atten = 1 - (dist / 340) * 0.42;
          const speckle = (deterministicNoise(Math.floor(x / 2), Math.floor(y / 2), 7) - 0.5) * 64;
          val = (118 + speckle) * atten;
          // Hypoechoic carotid artery & jugular vein cross-sections
          const artery = ellipseDist(x, y, cx - 54, 152, 22, 22);
          const vein = ellipseDist(x, y, cx + 58, 146, 26, 18);
          if (artery < 1) val = artery > 0.76 ? 190 : 18;
          if (vein < 1) val = vein > 0.78 ? 175 : 22;
          // Thyroid lobe / target parenchyma
          const lobe = ellipseDist(x, y, cx, 160, 44, 34);
          if (lobe < 1) {
            val = (145 + speckle * 0.85) * atten;
            // Small hypoechoic cyst / nodule with posterior acoustic enhancement
            const cyst = ellipseDist(x, y, cx - 10, 156, 11, 10);
            if (cyst < 1) val = 16;
          }
        }
      }

      field[y * BASE_SIZE + x] = Math.max(0, Math.min(255, Math.round(val + noise)));
    }
  }
  return field;
}

export function showDicomViewer(reportId) {
  const r = state.radiologyReports.find(x => Number(x.id) === Number(reportId)) ||
    state.radiologyReports[0] || {
      code: '802.130',
      description: 'PA Akciğer Grafisi',
      modality: 'CR',
      impression: 'Bilateral parankimal aktif infiltrasyon izlenmedi.',
      givenName: 'Ahmet',
      familyName: 'Yılmaz',
      mrn: 'HB-000104',
      dicomSeriesUid: '1.2.840.10008.5.1.4.1.1.1.2026.1'
    };

  const modality = detectModality(r);
  const preset = MODALITY_PRESETS[modality];
  const fullName = `${r.givenName || r.given_name || ''} ${r.familyName || r.family_name || ''}`.trim() || 'Hasta';
  const mrn = r.mrn || '—';
  const seriesUid = r.dicomSeriesUid || r.dicom_series_uid || `1.2.840.10008.5.1.4.${modality}.${r.id || 1}`;

  const body = `
    <div class="dicom-container">
      <div class="dicom-viewport" id="dicom-viewport">
        <canvas id="dicom-canvas" class="dicom-canvas" width="${BASE_SIZE}" height="${BASE_SIZE}"></canvas>
        <div class="dicom-overlay-top-left">
          <strong>${esc(fullName)}</strong><br>
          MRN: ${esc(mrn)}<br>
          ${esc(r.description || 'Radyoloji İnceleme')} [${esc(modality)}]<br>
          UID: ${esc(String(seriesUid).slice(-18))}
        </div>
        <div class="dicom-overlay-top-right">
          NOVA HBYS PACS<br>
          ${esc(preset.kvp)} | ${esc(preset.ma)}<br>
          ${preset.slices > 1 ? `Kesit: <span id="dicom-slice-label">12 / ${preset.slices}</span> (${esc(preset.thickness)})` : esc(preset.thickness)}
        </div>
        <div class="dicom-overlay-bottom-left">
          W: <span id="dicom-window-val">${preset.defaultW}</span> / L: <span id="dicom-level-val">${preset.defaultL}</span><br>
          Zoom: <span id="dicom-zoom-val">100%</span> | Pixel: ${preset.pxSpacingMm} mm
        </div>
        <div class="dicom-overlay-bottom-right" id="dicom-ruler-readout">
          Sürükle: Pan · Tekerlek: Zoom
        </div>
      </div>

      <div class="dicom-tools">
        <div class="dicom-tool-group">
          <span>W (Genişlik):</span>
          <input type="range" min="${preset.minW}" max="${preset.maxW}" value="${preset.defaultW}" class="dicom-slider" id="dicom-window-slider">
        </div>
        <div class="dicom-tool-group">
          <span>L (Seviye):</span>
          <input type="range" min="${preset.minL}" max="${preset.maxL}" value="${preset.defaultL}" class="dicom-slider" id="dicom-level-slider">
        </div>
        ${preset.slices > 1 ? `
          <div class="dicom-tool-group">
            <span>Kesit:</span>
            <input type="range" min="1" max="${preset.slices}" value="${Math.ceil(preset.slices / 2)}" class="dicom-slider" id="dicom-slice-slider">
          </div>
        ` : ''}
        <div class="dicom-tool-group">
          <button class="btn btn-light btn-sm" type="button" id="btn-dicom-zoom-in">+ Zoom</button>
          <button class="btn btn-light btn-sm" type="button" id="btn-dicom-zoom-out">− Zoom</button>
          <button class="btn btn-ghost btn-sm" type="button" id="btn-dicom-ruler">📏 Cetvel (mm)</button>
          <button class="btn btn-ghost btn-sm" type="button" id="btn-dicom-clear-ruler">Temizle</button>
          <label class="dicom-invert-label">
            <input type="checkbox" id="dicom-invert-check"> İnvert
          </label>
          <button class="btn btn-ghost btn-sm" type="button" id="btn-dicom-reset">Sıfırla</button>
        </div>
      </div>

      <div class="dicom-report-box">
        <strong>Radyolojik İzlenim (${esc(preset.label)}):</strong>
        <p>${esc(r.impression || 'Doğal radyolojik izlenim.')}</p>
      </div>
    </div>
  `;

  showModal(`PACS DICOM Görüntüleyici — ${r.description || modality}`, body, 'RADYOLOJİ PACS ARŞİVİ', true);
  requestAnimationFrame(() => initDicomCanvas(modality, preset));
}

function initDicomCanvas(modality, preset) {
  const canvas = $('#dicom-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const offscreen = document.createElement('canvas');
  offscreen.width = BASE_SIZE;
  offscreen.height = BASE_SIZE;
  const offCtx = offscreen.getContext('2d');
  const imgData = offCtx.createImageData(BASE_SIZE, BASE_SIZE);

  let windowWidth = preset.defaultW;
  let windowLevel = preset.defaultL;
  let sliceIndex = preset.slices > 1 ? Math.ceil(preset.slices / 2) : 1;
  let inverted = false;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let rulerMode = false;
  let measurements = [];
  let activeLine = null;
  let draggingPan = false;
  let panStart = { x: 0, y: 0 };

  let field = buildPhantomField(modality, sliceIndex, preset.slices);

  function toImageCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * BASE_SIZE;
    const sy = ((clientY - rect.top) / rect.height) * BASE_SIZE;
    const ix = (sx - BASE_SIZE / 2 - panX) / zoom + BASE_SIZE / 2;
    const iy = (sy - BASE_SIZE / 2 - panY) / zoom + BASE_SIZE / 2;
    return { x: ix, y: iy };
  }

  function renderOffscreen() {
    const low = windowLevel - windowWidth / 2;
    const invW = 1 / Math.max(1, windowWidth);
    const data = imgData.data;
    for (let i = 0; i < field.length; i++) {
      let norm = (field[i] - low) * invW;
      if (norm < 0) norm = 0;
      else if (norm > 1) norm = 1;
      let gray = Math.round(norm * 255);
      if (inverted) gray = 255 - gray;
      const idx = i * 4;
      data[idx] = gray;
      data[idx + 1] = gray;
      data[idx + 2] = gray;
      data[idx + 3] = 255;
    }
    offCtx.putImageData(imgData, 0, 0);
  }

  function drawRulerLine(m, isLive = false) {
    const dx = m.x2 - m.x1;
    const dy = m.y2 - m.y1;
    const distPx = Math.hypot(dx, dy);
    const mm = (distPx * preset.pxSpacingMm).toFixed(1);

    ctx.save();
    ctx.strokeStyle = isLive ? '#38bdf8' : '#facc15';
    ctx.fillStyle = isLive ? '#38bdf8' : '#facc15';
    ctx.lineWidth = Math.max(1.2, 1.8 / zoom);
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    ctx.stroke();

    for (const pt of [{ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(2.2, 3 / zoom), 0, Math.PI * 2);
      ctx.fill();
    }

    if (distPx > 4) {
      const mx = (m.x1 + m.x2) / 2;
      const my = (m.y1 + m.y2) / 2;
      ctx.font = `bold ${Math.max(9, Math.round(11 / zoom))}px ui-monospace, monospace`;
      const label = `${mm} mm`;
      const pad = 4 / zoom;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10, 14, 20, 0.85)';
      ctx.fillRect(mx - tw / 2 - pad, my - 12 / zoom, tw + pad * 2, 14 / zoom);
      ctx.fillStyle = isLive ? '#7dd3fc' : '#fde047';
      ctx.fillText(label, mx - tw / 2, my - 2 / zoom);
    }
    ctx.restore();
  }

  function draw() {
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, BASE_SIZE, BASE_SIZE);

    ctx.save();
    ctx.translate(BASE_SIZE / 2 + panX, BASE_SIZE / 2 + panY);
    ctx.scale(zoom, zoom);
    ctx.translate(-BASE_SIZE / 2, -BASE_SIZE / 2);
    ctx.drawImage(offscreen, 0, 0);

    // Subtle ultrasound depth ruler ticks on sector edge
    if (modality === 'US') {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
      ctx.lineWidth = 1;
      for (let cm = 2; cm <= 14; cm += 2) {
        const yTick = 26 + cm * 20;
        ctx.beginPath();
        ctx.moveTo(BASE_SIZE - 26, yTick);
        ctx.lineTo(BASE_SIZE - 16, yTick);
        ctx.stroke();
      }
    }

    for (const m of measurements) drawRulerLine(m, false);
    if (activeLine) drawRulerLine(activeLine, true);
    ctx.restore();
  }

  function updateReadout() {
    const wEl = $('#dicom-window-val');
    const lEl = $('#dicom-level-val');
    const zEl = $('#dicom-zoom-val');
    const sEl = $('#dicom-slice-label');
    if (wEl) wEl.textContent = String(windowWidth);
    if (lEl) lEl.textContent = String(windowLevel);
    if (zEl) zEl.textContent = `${Math.round(zoom * 100)}%`;
    if (sEl) sEl.textContent = `${sliceIndex} / ${preset.slices}`;
  }

  renderOffscreen();
  draw();
  updateReadout();

  $('#dicom-window-slider')?.addEventListener('input', e => {
    windowWidth = Number(e.target.value);
    renderOffscreen();
    draw();
    updateReadout();
  });

  $('#dicom-level-slider')?.addEventListener('input', e => {
    windowLevel = Number(e.target.value);
    renderOffscreen();
    draw();
    updateReadout();
  });

  $('#dicom-slice-slider')?.addEventListener('input', e => {
    sliceIndex = Number(e.target.value);
    field = buildPhantomField(modality, sliceIndex, preset.slices);
    renderOffscreen();
    draw();
    updateReadout();
  });

  $('#dicom-invert-check')?.addEventListener('change', e => {
    inverted = Boolean(e.target.checked);
    renderOffscreen();
    draw();
  });

  $('#btn-dicom-zoom-in')?.addEventListener('click', () => {
    zoom = Math.min(4, Number((zoom + 0.25).toFixed(2)));
    draw();
    updateReadout();
  });

  $('#btn-dicom-zoom-out')?.addEventListener('click', () => {
    zoom = Math.max(0.5, Number((zoom - 0.25).toFixed(2)));
    draw();
    updateReadout();
  });

  const rulerBtn = $('#btn-dicom-ruler');
  rulerBtn?.addEventListener('click', () => {
    rulerMode = !rulerMode;
    rulerBtn.classList.toggle('btn-primary', rulerMode);
    rulerBtn.classList.toggle('btn-ghost', !rulerMode);
    canvas.style.cursor = rulerMode ? 'crosshair' : 'grab';
    const hint = $('#dicom-ruler-readout');
    if (hint) hint.textContent = rulerMode ? 'Cetvel Aktif: İki nokta arası sürükleyin' : 'Sürükle: Pan · Tekerlek: Zoom';
  });

  $('#btn-dicom-clear-ruler')?.addEventListener('click', () => {
    measurements = [];
    activeLine = null;
    draw();
  });

  $('#btn-dicom-reset')?.addEventListener('click', () => {
    windowWidth = preset.defaultW;
    windowLevel = preset.defaultL;
    inverted = false;
    zoom = 1;
    panX = 0;
    panY = 0;
    measurements = [];
    activeLine = null;
    if ($('#dicom-window-slider')) $('#dicom-window-slider').value = String(preset.defaultW);
    if ($('#dicom-level-slider')) $('#dicom-level-slider').value = String(preset.defaultL);
    if ($('#dicom-invert-check')) $('#dicom-invert-check').checked = false;
    renderOffscreen();
    draw();
    updateReadout();
  });

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    if (rulerMode) {
      const pt = toImageCoords(e.clientX, e.clientY);
      activeLine = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      draw();
    } else {
      draggingPan = true;
      panStart = { x: e.clientX - panX, y: e.clientY - panY };
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (rulerMode && activeLine) {
      const pt = toImageCoords(e.clientX, e.clientY);
      activeLine.x2 = pt.x;
      activeLine.y2 = pt.y;
      const distMm = (Math.hypot(activeLine.x2 - activeLine.x1, activeLine.y2 - activeLine.y1) * preset.pxSpacingMm).toFixed(1);
      const hint = $('#dicom-ruler-readout');
      if (hint) hint.textContent = `Ölçüm: ${distMm} mm`;
      draw();
    } else if (draggingPan) {
      panX = e.clientX - panStart.x;
      panY = e.clientY - panStart.y;
      draw();
    }
  });

  const endPointer = e => {
    if (rulerMode && activeLine) {
      if (Math.hypot(activeLine.x2 - activeLine.x1, activeLine.y2 - activeLine.y1) > 4) {
        measurements.push(activeLine);
      }
      activeLine = null;
      draw();
    }
    draggingPan = false;
    canvas.style.cursor = rulerMode ? 'crosshair' : 'grab';
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    zoom = Math.max(0.5, Math.min(4, Number((zoom + delta).toFixed(2))));
    draw();
    updateReadout();
  }, { passive: false });
}
