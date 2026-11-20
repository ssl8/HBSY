import { api } from '../api.js';
import {
  $,
  badge,
  dateTime,
  empty,
  esc,
  heading,
  table,
  toast,
} from '../dom.js';
import { hasRole } from '../state.js';

let activeTab = 'overview';
let lastMedulaResult = null;
let lastItsResult = null;

export function setConnectorsTab(tab) {
  if (tab) activeTab = tab;
}

function getAllowedTabs() {
  const tabs = [{ id: 'overview', label: 'Genel Durum', roles: ['admin', 'doctor', 'nurse', 'pharmacist', 'billing', 'registrar', 'integration'] }];
  tabs.push({ id: 'mhrs', label: 'MHRS Randevu', roles: ['admin', 'doctor', 'registrar', 'integration'] });
  tabs.push({ id: 'ulak', label: 'Acil 112 / ULAK', roles: ['admin', 'doctor', 'nurse', 'integration'] });
  tabs.push({ id: 'medula', label: 'MEDULA GSS', roles: ['admin', 'billing', 'registrar', 'integration'] });
  tabs.push({ id: 'enabiz', label: 'USS / e-Nabız', roles: ['admin', 'doctor', 'integration'] });
  tabs.push({ id: 'its', label: 'İTS / ÜTS Barkod', roles: ['admin', 'pharmacist', 'integration'] });
  return tabs.filter((t) => hasRole(...t.roles));
}

function gatewayEntries(gateways) {
  if (!gateways) return [];
  if (Array.isArray(gateways)) return gateways;
  return Object.entries(gateways).map(([key, val]) => ({
    key,
    ...(typeof val === 'object' && val ? val : { name: key, status: String(val || 'Online') }),
  }));
}

export async function renderConnectors() {
  const allowedTabs = getAllowedTabs();
  if (!allowedTabs.some((t) => t.id === activeTab)) {
    activeTab = allowedTabs[0]?.id || 'overview';
  }

  let tabContent = '';

  if (activeTab === 'overview') {
    const overview = await api('/api/connectors/overview');
    const gateways = gatewayEntries(overview?.gateways);
    const counts = overview?.counts || {};
    tabContent = `
      <section class="kpi-grid kpi-grid-compact">
        <article class="kpi-card">
          <span class="kpi-label">Aktif Kapı Sayısı</span>
          <strong class="kpi-value">${esc(counts.totalGateways ?? gateways.length)}</strong>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">Günlük Mesaj Trafiği</span>
          <strong class="kpi-value">${esc(counts.totalTrafficToday ?? 0)}</strong>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">Bekleyen Outbox</span>
          <strong class="kpi-value">${esc(counts.pendingOutbox ?? 0)}</strong>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">Hatalı Outbox</span>
          <strong class="kpi-value text-danger">${esc(counts.failedOutbox ?? 0)}</strong>
        </article>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Ulusal Sağlık Ağ Geçitleri</h2>
            <p class="panel-sub">Canlı protokol uç noktaları ve yanıt gecikmeleri</p>
          </div>
        </div>
        <div class="gateway-grid">
          ${gateways.map((gw) => `
            <article class="gateway-card">
              <div class="gateway-card-head">
                <strong>${esc(gw.name || gw.label || gw.key?.toUpperCase())}</strong>
                ${badge(gw.status || 'Online')}
              </div>
              <div class="gateway-card-meta">
                <span>${esc(gw.protocol || 'REST / SOAP')}</span>
                ${gw.latencyMs !== undefined ? `<span>${esc(gw.latencyMs)} ms</span>` : ''}
              </div>
              ${gw.endpoint ? `<div class="table-sub">${esc(gw.endpoint)}</div>` : ''}
            </article>
          `).join('')}
        </div>
      </section>
    `;
  } else if (activeTab === 'mhrs') {
    const appts = await api('/api/connectors/mhrs/appointments');
    const list = Array.isArray(appts) ? appts : [];
    const rows = list.map((a) => {
      const admitted = a.status === 'Admitted';
      return `
        <tr>
          <td><strong>${esc(a.id)}</strong></td>
          <td>${esc(a.slotTime || dateTime(a.appointmentTime || a.createdAt))}</td>
          <td>${esc(a.polyclinic || '-')}</td>
          <td>${esc(a.doctor || '-')}</td>
          <td>
            <div class="cell-strong">${esc(a.patientName || '-')}</div>
            <div class="table-sub">${esc(a.patientRef || '')}</div>
          </td>
          <td>${badge(a.status || 'Booked')}</td>
          <td>${esc(a.medulaTakipNo || '-')}</td>
          <td>
            ${admitted
              ? `<span class="badge badge-success">Kabul #${esc(a.encounterId || '')}</span>`
              : `<button type="button" class="btn btn-sm btn-primary" data-mhrs-admit="${esc(a.id)}">Kabul Et & Karşılaşma Aç</button>`}
          </td>
        </tr>
      `;
    }).join('');

    tabContent = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>MHRS Merkezi Hekim Randevu Listesi</h2>
            <p class="panel-sub">Randevudan tek tıkla HBYS karşılaşması ve MEDULA takip numarası açılır</p>
          </div>
          <button type="button" id="btn-mhrs-sync" class="btn btn-primary btn-sm">↻ MHRS Senkronize Et</button>
        </div>
        ${list.length
          ? table(['Randevu ID', 'Saat', 'Poliklinik', 'Hekim', 'Hasta', 'Durum', 'MEDULA Takip', 'İşlem'], rows)
          : empty('MHRS randevusu bulunamadı.')}
      </section>
    `;
  } else if (activeTab === 'ulak') {
    const cases = await api('/api/connectors/ulak/cases');
    const list = Array.isArray(cases) ? cases : [];
    const rows = list.map((c) => {
      const admitted = c.status === 'Admitted' || Boolean(c.encounterId);
      return `
        <tr>
          <td><strong>${esc(c.id)}</strong></td>
          <td>${esc(c.patientName || `Hasta #${c.patientId}`)}</td>
          <td>${badge(c.priority || c.triageCode || 'Red')}</td>
          <td>${esc(c.location || c.incidentLocation || '-')}</td>
          <td>${esc(c.etrMinutes ?? c.etaMinutes ?? '-')} dk</td>
          <td>${badge(c.status || 'EnRoute')}</td>
          <td>
            ${admitted
              ? `<span class="badge badge-success">Acil Kabul #${esc(c.encounterId || '')}</span>`
              : `<button type="button" class="btn btn-sm btn-danger" data-ulak-admit="${esc(c.id)}">Acil Karşılaşmaya Al</button>`}
          </td>
        </tr>
      `;
    }).join('');

    tabContent = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>112 Acil Komuta / ULAK Ambulans Vaka Bildirimi</h2>
            <p class="panel-sub">Yeni 112 sevk kaydı oluşturun veya gelen vakayı acil karşılaşma olarak kabul edin</p>
          </div>
        </div>
        <form id="form-ulak-dispatch" class="form-inline-grid">
          <label class="field">
            <span>Hasta Adı / Yaş-Cinsiyet *</span>
            <input name="patientName" required value="Selin Aydın (19K)" />
          </label>
          <label class="field">
            <span>Hasta ID</span>
            <input type="number" name="patientId" value="11" min="1" />
          </label>
          <label class="field">
            <span>Triyaj / Öncelik *</span>
            <select name="priority">
              <option value="Red">Kırmızı Alan (Red)</option>
              <option value="Yellow">Sarı Alan (Yellow)</option>
              <option value="Green">Yeşil Alan (Green)</option>
            </select>
          </label>
          <label class="field">
            <span>Konum / İstasyon *</span>
            <input name="location" required value="Kadıköy 4 No'lu İstasyon" />
          </label>
          <div class="field-btn">
            <button type="submit" class="btn btn-primary btn-sm">+ 112 Vaka Dispatch</button>
          </div>
        </form>
        ${list.length
          ? table(['Vaka Kodu', 'Hasta', 'Triyaj', 'Konum / İstasyon', 'Tahmini Varış', 'Durum', 'Acil Kabul'], rows)
          : empty('Aktif 112 / ULAK vakası yok.')}
      </section>
    `;
  } else if (activeTab === 'medula') {
    const provisions = await api('/api/connectors/medula/provisions');
    const list = Array.isArray(provisions) ? provisions : [];
    const rows = list.map((p) => `
      <tr>
        <td><strong>${esc(p.takipNo)}</strong></td>
        <td>${esc(p.patientRef || '-')}</td>
        <td>${esc(p.sigortaliTuru || '-')}</td>
        <td>${esc(p.bransKodu || '-')}</td>
        <td>${badge(p.provizyonTipi || 'Normal')}</td>
        <td>${esc(p.katilimPayi ?? 0)} TRY</td>
        <td>${badge(p.sonucKodu === '0000' ? 'Approved' : p.sonucKodu)} ${esc(p.sonucMesaji || '')}</td>
        <td>${esc(dateTime(p.sorgulamaZamani || p.createdAt))}</td>
      </tr>
    `).join('');

    tabContent = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>SGK MEDULA GSS Provizyon Sorgulama</h2>
            <p class="panel-sub">Gerçek zamanlı hak sahipliği ve takip numarası üretimi</p>
          </div>
        </div>
        <form id="form-medula-prov" class="form-inline-grid">
          <label class="field">
            <span>TCKN *</span>
            <input name="tckn" required maxlength="11" value="28491028472" />
          </label>
          <label class="field">
            <span>Branş Kodu *</span>
            <input name="bransKodu" required value="1000" />
          </label>
          <label class="field">
            <span>Sigortalı Türü *</span>
            <select name="sigortaliTuru">
              <option value="4A (SSK Aktif Çalışan)">4A (SSK Aktif Çalışan)</option>
              <option value="4B (Bağ-Kur)">4B (Bağ-Kur)</option>
              <option value="4C (Emekli Sandığı)">4C (Emekli Sandığı)</option>
            </select>
          </label>
          <label class="field">
            <span>Provizyon Tipi *</span>
            <select name="provizyonTipi">
              <option value="Normal">Normal</option>
              <option value="Acil">Acil</option>
              <option value="Adli">Adli Vaka</option>
            </select>
          </label>
          <div class="field-btn">
            <button type="submit" class="btn btn-primary btn-sm">Provizyon Al</button>
          </div>
        </form>
        ${lastMedulaResult ? `
          <div class="alert-banner alert-success">
            <strong>Sonuç (${esc(lastMedulaResult.sonucKodu)}):</strong>
            Takip No: <strong>${esc(lastMedulaResult.takipNo)}</strong> · ${esc(lastMedulaResult.sonucMesaji)} · Katılım Payı: ${esc(lastMedulaResult.katilimPayi)} TRY
          </div>
        ` : ''}
        ${list.length
          ? table(['Takip No', 'Hasta Ref', 'Sigortalı Türü', 'Branş', 'Tip', 'Katılım Payı', 'Sonuç', 'Tarih'], rows)
          : empty('Provizyon geçmişi boş.')}
      </section>
    `;
  } else if (activeTab === 'enabiz') {
    const packages = await api('/api/connectors/enabiz/packages');
    const list = Array.isArray(packages) ? packages : [];
    const rows = list.map((pkg) => `
      <tr>
        <td><strong>${esc(pkg.sysTakipNo)}</strong></td>
        <td>${esc(pkg.packageType)}</td>
        <td>${esc(pkg.encounterId ? `Karşılaşma #${pkg.encounterId}` : (pkg.patientId ? `Hasta #${pkg.patientId}` : '-'))}</td>
        <td>${badge(pkg.status || 'Sent')}</td>
        <td>${esc(pkg.responseCode || 'SYS_0000')} — ${esc(pkg.responseMessage || '')}</td>
        <td>${esc(dateTime(pkg.sentAt || pkg.createdAt))}</td>
      </tr>
    `).join('');

    tabContent = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Sağlık Bakanlığı USS / e-Nabız Veri Paketi Gönderimi</h2>
            <p class="panel-sub">Paket101 (Hasta Kayıt), Paket103 (Muayene), Paket105 (Lab/Sonuç) ve SYS Takip No</p>
          </div>
        </div>
        <form id="form-enabiz-send" class="form-inline-grid">
          <label class="field">
            <span>USS Paket Türü *</span>
            <select name="packageType">
              <option value="Paket101_HastaKayit">Paket101_HastaKayit</option>
              <option value="Paket103_MuayeneBilgisi">Paket103_MuayeneBilgisi</option>
              <option value="Paket105_TetkikSonuc">Paket105_TetkikSonuc</option>
              <option value="Paket201_YatisBilgisi">Paket201_YatisBilgisi</option>
            </select>
          </label>
          <label class="field">
            <span>Hasta ID</span>
            <input type="number" name="patientId" min="1" value="1" />
          </label>
          <label class="field">
            <span>Karşılaşma ID</span>
            <input type="number" name="encounterId" min="1" value="1" />
          </label>
          <div class="field-btn">
            <button type="submit" class="btn btn-primary btn-sm">e-Nabız Paketi Gönder</button>
          </div>
        </form>
        ${list.length
          ? table(['SYS Takip No', 'Paket', 'Hedef Kayıt', 'Durum', 'Bakanlık Yanıtı', 'Gönderim Zamanı'], rows)
          : empty('Gönderilmiş USS/e-Nabız paketi yok.')}
      </section>
    `;
  } else if (activeTab === 'its') {
    tabContent = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>İTS / ÜTS İlaç ve Tıbbi Cihaz Karekod Doğrulama</h2>
            <p class="panel-sub">GTIN / Karekod üzerinden son kullanma tarihi, parti ve ruhsat durumu sorgulayın</p>
          </div>
        </div>
        <form id="form-its-verify" class="form-inline-grid">
          <label class="field field-wide">
            <span>İTS Barkod / ÜTS Karekod *</span>
            <input name="barcode" required value="8699525010050" placeholder="8699525010050" />
          </label>
          <div class="field-btn">
            <button type="submit" class="btn btn-primary btn-sm">Barkod Doğrula</button>
          </div>
        </form>
        ${lastItsResult ? `
          <div class="alert-banner alert-success">
            <div>
              <strong>${esc(lastItsResult.productName)} (${esc(lastItsResult.genericName || '-')})</strong>
              <span>
                Durum: <strong>${esc(lastItsResult.status)}</strong> ·
                Lot: ${esc(lastItsResult.lotNo)} ·
                ÜTS/İTS: ${esc(lastItsResult.itsCode || lastItsResult.utsCode)} ·
                SKT: ${esc(lastItsResult.expiryDate)}
              </span>
            </div>
          </div>
        ` : empty('Doğrulama yapmak için yukarıdaki barkodu sorgulayın.')}
      </section>
    `;
  }

  return `
    ${heading('ULUSAL ENTEGRASYONLAR', 'Ulusal Sağlık Kapıları', 'MHRS, ULAK 112, SGK MEDULA, USS / e-Nabız ve İTS gerçek zamanlı servis kapıları')}

    <div class="tab-bar">
      ${allowedTabs.map((t) => `
        <button type="button" class="tab-btn ${activeTab === t.id ? 'is-active' : ''}" data-conn-tab="${esc(t.id)}">${esc(t.label)}</button>
      `).join('')}
    </div>

    ${tabContent}
  `;
}

export function bindConnectorsEvents(container, { reload }) {
  if (!container) return;

  container.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-conn-tab]');
    if (tabBtn) {
      activeTab = tabBtn.dataset.connTab;
      await reload();
      return;
    }

    if (e.target.closest('#btn-mhrs-sync')) {
      try {
        const res = await api('/api/connectors/mhrs/sync', { method: 'POST' });
        toast(`MHRS randevu listesi güncellendi (${res.count ?? '-'} kayıt).`);
        await reload();
      } catch (err) {
        toast(err?.message || 'MHRS senkronizasyonu başarısız.', 'error');
      }
      return;
    }

    const mhrsAdmit = e.target.closest('[data-mhrs-admit]');
    if (mhrsAdmit) {
      try {
        const res = await api('/api/connectors/mhrs/admit', {
          method: 'POST',
          body: { appointmentId: mhrsAdmit.dataset.mhrsAdmit },
        });
        toast(`MHRS kabulü tamamlandı (Karşılaşma #${res.encounter?.id || ''}).`);
        await reload();
      } catch (err) {
        toast(err?.message || 'MHRS kabulü başarısız.', 'error');
      }
      return;
    }

    const ulakAdmit = e.target.closest('[data-ulak-admit]');
    if (ulakAdmit) {
      try {
        const res = await api('/api/connectors/ulak/admit', {
          method: 'POST',
          body: { caseId: ulakAdmit.dataset.ulakAdmit },
        });
        toast(`112 Acil kabulü oluşturuldu (Karşılaşma #${res.encounter?.id || ''}).`);
        await reload();
      } catch (err) {
        toast(err?.message || '112 acil kabulü başarısız.', 'error');
      }
    }
  });

  container.addEventListener('submit', async (e) => {
    if (e.target.id === 'form-ulak-dispatch') {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const created = await api('/api/connectors/ulak/dispatch', {
          method: 'POST',
          body: {
            patientName: String(fd.get('patientName') || '').trim(),
            patientId: Number(fd.get('patientId') || 11),
            priority: String(fd.get('priority') || 'Red'),
            location: String(fd.get('location') || '').trim(),
          },
        });
        toast(`112/ULAK vakası oluşturuldu: ${created.id || ''}`);
        await reload();
      } catch (err) {
        toast(err?.message || 'ULAK dispatch başarısız.', 'error');
      }
      return;
    }

    if (e.target.id === 'form-medula-prov') {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        lastMedulaResult = await api('/api/connectors/medula/provision', {
          method: 'POST',
          body: {
            tckn: String(fd.get('tckn') || '').trim(),
            bransKodu: String(fd.get('bransKodu') || '').trim(),
            sigortaliTuru: String(fd.get('sigortaliTuru') || '').trim(),
            provizyonTipi: String(fd.get('provizyonTipi') || 'Normal'),
          },
        });
        toast(`MEDULA provizyon alındı: ${lastMedulaResult.takipNo || ''}`);
        await reload();
      } catch (err) {
        toast(err?.message || 'MEDULA provizyon sorgusu başarısız.', 'error');
      }
      return;
    }

    if (e.target.id === 'form-enabiz-send') {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const pkg = await api('/api/connectors/enabiz/send', {
          method: 'POST',
          body: {
            packageType: String(fd.get('packageType')),
            patientId: fd.get('patientId') ? Number(fd.get('patientId')) : null,
            encounterId: fd.get('encounterId') ? Number(fd.get('encounterId')) : null,
          },
        });
        toast(`e-Nabız paketi gönderildi: ${pkg.sysTakipNo || ''}`);
        await reload();
      } catch (err) {
        toast(err?.message || 'e-Nabız gönderimi başarısız.', 'error');
      }
      return;
    }

    if (e.target.id === 'form-its-verify') {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        lastItsResult = await api('/api/connectors/its/verify', {
          method: 'POST',
          body: { barcode: String(fd.get('barcode') || '').trim() },
        });
        toast(`İTS doğrulama sonucu: ${lastItsResult.status || 'Uygun'}`);
        await reload();
      } catch (err) {
        toast(err?.message || 'İTS barkod doğrulanamadı.', 'error');
      }
    }
  });
}
