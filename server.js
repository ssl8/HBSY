// NOVA HBYS — Stage 4 Demonstration & Parity Server
// Pure Node.js (zero external dependencies) — Runs on Node 18+
// Implements full REST API parity with .NET 10 microservices + UNIFIED-CONTRACT.md

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const WEB_ROOT = path.resolve(__dirname, 'web');

// --- CANONICAL 9-ROLE DEFINITIONS (UNIFIED-CONTRACT.md §2) ---
const ALL_ROLES = [
  'admin', 'doctor', 'nurse', 'lab', 'radiology',
  'pharmacist', 'billing', 'registrar', 'integration'
];

const ROLE_LABELS = {
  admin: 'Sistem Yöneticisi',
  doctor: 'Hekim',
  nurse: 'Hemşire',
  lab: 'Laboratuvar Teknisyeni',
  radiology: 'Radyoloji Teknisyeni',
  pharmacist: 'Eczacı',
  billing: 'Faturalama Uzmanı',
  registrar: 'Hasta Kayıt Görevlisi',
  integration: 'Entegrasyon Operatörü'
};

const DEMO_USERS = {
  admin: { id: 'usr-adm', username: 'admin', displayName: 'Prof. Dr. Başhekim / Admin', role: 'admin', roles: ['admin'], specialty: 'Hastane Yönetimi' },
  doctor: { id: 'usr-doc', username: 'doctor', displayName: 'Uzm. Dr. Mehmet Kaya', role: 'doctor', roles: ['doctor'], specialty: 'İç Hastalıkları' },
  nurse: { id: 'usr-nur', username: 'nurse', displayName: 'Hemşire Elif Yıldız', role: 'nurse', roles: ['nurse'], specialty: 'Klinik & Acil Triyaj' },
  lab: { id: 'usr-lab', username: 'lab', displayName: 'Uzm. Biyolog Caner Öztürk', role: 'lab', roles: ['lab'], specialty: 'Biyokimya & Hematoloji' },
  radiology: { id: 'usr-rad', username: 'radiology', displayName: 'Uzm. Dr. Burak Koç', role: 'radiology', roles: ['radiology'], specialty: 'Radyoloji & PACS' },
  pharmacist: { id: 'usr-pha', username: 'pharmacist', displayName: 'Ecz. Selin Aydın', role: 'pharmacist', roles: ['pharmacist'], specialty: 'Klinik Eczacılık' },
  billing: { id: 'usr-bil', username: 'billing', displayName: 'Finans Uzm. Ayşe Aksoy', role: 'billing', roles: ['billing'], specialty: 'SGK MEDULA & Faturalama' },
  registrar: { id: 'usr-reg', username: 'registrar', displayName: 'Kayıt Uzm. Deniz Arslan', role: 'registrar', roles: ['registrar'], specialty: 'Hasta Kabul & MHRS' },
  integration: { id: 'usr-int', username: 'integration', displayName: 'Entegrasyon Operatörü', role: 'integration', roles: ['integration'], specialty: 'Dış Sistemler & Ağ' }
};

const USERNAME_TO_ROLE = {
  ...Object.fromEntries(ALL_ROLES.map(r => [r, r])),
  pharmacy: 'pharmacist'
};

// --- DOMAIN HELPERS ---

const ORDER_ALLOWED_TRANSITIONS = {
  Created: ['Submitted', 'Cancelled'],
  Submitted: ['InProgress', 'Cancelled', 'Rejected'],
  InProgress: ['Resulted', 'Cancelled'],
  Resulted: ['Verified'],
  Rejected: ['Submitted'],
  Verified: [],
  Cancelled: []
};

const ALLOWED_ORDER_TYPES = new Set(['LAB', 'RAD', 'PROCEDURE', 'CONSULT', 'DRUG']);

function checkOrderTransition(fromStatus, toStatus, role, orderType) {
  const allowedTargets = ORDER_ALLOWED_TRANSITIONS[fromStatus];
  if (!allowedTargets || !allowedTargets.includes(toStatus)) {
    return {
      ok: false,
      statusCode: 409,
      error: `'${fromStatus}' durumundan '${toStatus}' durumuna geçiş yapılamaz.`
    };
  }
  const type = String(orderType || '').toUpperCase();
  const isLabRole = role === 'lab' && type === 'LAB';
  const isRadiologyRole = role === 'radiology' && type === 'RAD';
  const isClinicalProcRole = role === 'doctor' && (type === 'PROCEDURE' || type === 'CONSULT' || type === 'DRUG');

  let rolePermitted = false;
  switch (toStatus) {
    case 'Submitted':
    case 'Cancelled':
    case 'Verified':
      rolePermitted = role === 'doctor' || role === 'admin';
      break;
    case 'InProgress':
    case 'Resulted':
    case 'Rejected':
      rolePermitted = isLabRole || isRadiologyRole || isClinicalProcRole || role === 'admin';
      break;
    default:
      rolePermitted = false;
  }

  if (!rolePermitted) {
    return {
      ok: false,
      statusCode: 403,
      error: `'${role}' rolü '${type}' istemini '${toStatus}' durumuna geçirme yetkisine sahip değildir.`
    };
  }
  return { ok: true };
}

function roundMoney(val) {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function hasMaxTwoDecimals(val) {
  return Math.abs(Math.round(val * 100) - val * 100) < 1e-6;
}

function parsePositiveMoney(raw, label, max = 9999999.99) {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0 || num > max) {
    throw new HttpError(400, `${label} 0'dan büyük ve en fazla ${max} olmalıdır.`);
  }
  if (!hasMaxTwoDecimals(num)) {
    throw new HttpError(400, `${label} en fazla iki ondalık basamak içerebilir.`);
  }
  return roundMoney(num);
}

function computeNews2({ systolicBp, diastolicBp, heartRate, respRate, tempC, spo2, consciousness }) {
  const sbp = Number(systolicBp);
  const dbp = Number(diastolicBp);
  const hr = Number(heartRate);
  const rr = Number(respRate);
  const temp = Number(tempC);
  const ox = Number(spo2);
  const cons = String(consciousness || 'A').trim().toUpperCase();

  if (!Number.isFinite(rr) || rr < 4 || rr > 60) throw new HttpError(400, 'Solunum sayısı (respRate) 4-60 arasında olmalıdır.');
  if (!Number.isFinite(ox) || ox < 40 || ox > 100) throw new HttpError(400, 'SpO2 40-100 arasında olmalıdır.');
  if (!Number.isFinite(temp) || temp < 25 || temp > 45) throw new HttpError(400, 'Vücut ısısı (tempC) 25-45 °C arasında olmalıdır.');
  if (!Number.isFinite(sbp) || sbp < 30 || sbp > 300) throw new HttpError(400, 'Sistolik KB (systolicBp) 30-300 mmHg arasında olmalıdır.');
  if (!Number.isFinite(dbp) || dbp < 20 || dbp > 200) throw new HttpError(400, 'Diyastolik KB (diastolicBp) 20-200 mmHg arasında olmalıdır.');
  if (!Number.isFinite(hr) || hr < 20 || hr > 260) throw new HttpError(400, 'Nabız (heartRate) 20-260 atım/dk arasında olmalıdır.');
  if (!['A', 'V', 'P', 'U'].includes(cons)) throw new HttpError(400, 'Bilinç düzeyi (consciousness) A, V, P veya U olmalıdır.');

  const rrScore = rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3;
  const spo2Score = ox <= 91 ? 3 : ox <= 93 ? 2 : ox <= 95 ? 1 : 0;
  const tempScore = temp <= 35.0 ? 3 : temp <= 36.0 ? 1 : temp <= 38.0 ? 0 : temp <= 39.0 ? 1 : 2;
  const sbpScore = sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3;
  const hrScore = hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3;
  const consScore = cons === 'A' ? 0 : 3;

  const scores = [rrScore, spo2Score, tempScore, sbpScore, hrScore, consScore];
  const news2Score = scores.reduce((a, b) => a + b, 0);
  const hasRedScore = scores.some(s => s === 3);

  let news2Risk = 'LOW';
  if (news2Score >= 7) news2Risk = 'HIGH';
  else if (news2Score >= 5) news2Risk = 'MEDIUM';
  else if (hasRedScore) news2Risk = 'LOW_MEDIUM';

  return {
    systolicBp: sbp,
    diastolicBp: dbp,
    heartRate: hr,
    respRate: rr,
    tempC: Math.round(temp * 10) / 10,
    spo2: ox,
    consciousness: cons,
    news2Score,
    news2Risk
  };
}

function evaluateCriticalLab({ analyteCode, display, value, flag, critical }) {
  const f = String(flag || 'N').trim().toUpperCase();
  if (Boolean(critical) || f === 'HH' || f === 'LL' || f === 'AA') return true;
  const numeric = parseFloat(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(numeric)) return false;

  const label = `${analyteCode || ''} ${display || ''}`.toLocaleLowerCase('tr');
  if (label.includes('10839-9') || label.includes('troponin')) return numeric > 0.04;
  if (label.includes('2823-3') || label.includes('potasyum') || label.includes('potassium') || /\bk\+?\b/.test(label)) {
    return numeric >= 6.0 || numeric <= 2.8;
  }
  if (label.includes('2345-7') || label.includes('glukoz') || label.includes('glucose') || label.includes('kan şekeri')) {
    return numeric >= 400 || numeric <= 45;
  }
  if (label.includes('718-7') || label.includes('hemoglobin') || /\bhgb\b/.test(label)) {
    return numeric <= 7.0;
  }
  return false;
}

const ALLERGY_SYNONYM_GROUPS = [
  ['penisilin', 'penicillin', 'amoksisilin', 'amoxicillin', 'ampisilin', 'ampicillin', 'klavulanat', 'beta-lactam', 'beta-laktam', 'betalaktam'],
  ['seftriakson', 'ceftriaxone', 'sefalosporin', 'cephalosporin', 'beta-lactam', 'beta-laktam'],
  ['aspirin', 'asetilsalisilik', 'acetylsalicylic', 'salisilat', 'nsaid', 'diklofenak', 'diclofenac', 'ibuprofen', 'naproksen'],
  ['sulfa', 'sulfonamid', 'sulfonamide', 'sülfonamid', 'trimetoprim', 'sulfametoksazol', 'sulfamethoxazole']
];

function parseAllergyTokens(allergiesValue) {
  if (Array.isArray(allergiesValue)) {
    return allergiesValue
      .map(v => String(v || '').trim())
      .filter(v => v && !['yok', 'none', 'bilinmiyor', '-'].includes(v.toLocaleLowerCase('tr')));
  }
  return String(allergiesValue || '')
    .split(/[,;]+/)
    .map(v => v.trim())
    .filter(v => v && !['yok', 'none', 'bilinmiyor', '-'].includes(v.toLocaleLowerCase('tr')));
}

function matchDrugAllergyConflict(patientAllergies, drug) {
  const tokens = parseAllergyTokens(patientAllergies);
  if (!tokens.length || !drug) return null;

  const drugText = `${drug.name || ''} ${drug.genericName || ''} ${drug.allergyGroup || ''}`.toLocaleLowerCase('tr');
  const drugGroups = new Set();
  for (const group of ALLERGY_SYNONYM_GROUPS) {
    if (group.some(term => drugText.includes(term))) {
      for (const term of group) drugGroups.add(term);
    }
  }

  for (const token of tokens) {
    const norm = token.toLocaleLowerCase('tr');
    if (drugText.includes(norm)) return token;
    for (const group of ALLERGY_SYNONYM_GROUPS) {
      if (group.some(term => norm.includes(term) || term.includes(norm)) && drugGroups.has(group[0])) {
        return token;
      }
    }
  }
  return null;
}

function parseHl7Oru(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(400, 'HL7 mesajı boş olamaz.');
  }
  if (raw.length > 1_000_000) {
    throw new HttpError(400, 'HL7 mesajı 1 MB sınırını aşıyor.');
  }
  const normalized = raw.replace(/\u000b/g, '').replace(/\u001c/g, '');
  const segments = normalized.split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean);
  const msh = segments.find(s => s.startsWith('MSH'));
  if (!msh || msh.length < 4) {
    throw new HttpError(400, 'HL7 MSH segmenti bulunamadı veya bozuk.');
  }

  const sep = msh[3];
  const mshFields = msh.split(sep);
  const sendingApp = (mshFields[2] || '').trim() || 'HL7-DEVICE';
  const messageTimestamp = (mshFields[6] || '').trim() || null;
  const messageType = (mshFields[8] || '').trim();
  if (!messageType.toUpperCase().startsWith('ORU^R01')) {
    throw new HttpError(400, 'Yalnızca HL7 ORU^R01 mesajları kabul edilir.');
  }
  const controlId = (mshFields[9] || '').trim();
  if (!controlId || controlId.length > 100) {
    throw new HttpError(400, 'MSH-10 mesaj kontrol numarası zorunludur (en fazla 100 karakter).');
  }

  const pid = segments.find(s => s.startsWith('PID' + sep));
  if (!pid) throw new HttpError(400, 'HL7 PID segmenti bulunamadı.');
  const pidFields = pid.split(sep);
  const patientIdentifier = ((pidFields[3] || '').split('^')[0] || '').trim();
  if (!patientIdentifier || patientIdentifier.length > 32) {
    throw new HttpError(400, 'PID-3 hasta numarası zorunludur (en fazla 32 karakter).');
  }

  const obr = segments.find(s => s.startsWith('OBR' + sep));
  if (!obr) throw new HttpError(400, 'HL7 OBR segmenti bulunamadı.');
  const obrFields = obr.split(sep);
  const orderIdentifier = ((obrFields[3] || '').split('^')[0] || '').trim();
  if (!orderIdentifier) throw new HttpError(400, 'OBR-3 istem numarası zorunludur.');
  const obrTestParts = (obrFields[4] || '').split('^').map(s => s.trim());
  const testCode = obrTestParts[0] || '';
  if (!testCode || testCode.length > 80) {
    throw new HttpError(400, 'OBR-4 tetkik kodu zorunludur (en fazla 80 karakter).');
  }
  const testDisplay = obrTestParts[1] || testCode;

  const obxSegments = segments.filter(s => s.startsWith('OBX' + sep));
  if (obxSegments.length === 0) {
    throw new HttpError(400, 'ORU mesajında en az bir OBX sonucu bulunmalıdır.');
  }
  if (obxSegments.length > 1000) {
    throw new HttpError(400, 'Bir HL7 ORU mesajında en fazla 1000 OBX sonucu kabul edilir.');
  }

  const observations = obxSegments.map(seg => {
    const f = seg.split(sep);
    const parts = (f[3] || '').split('^').map(s => s.trim());
    const code = parts[0] || '';
    if (!code || code.length > 80) {
      throw new HttpError(400, 'OBX-3 analit kodu zorunludur (en fazla 80 karakter).');
    }
    const display = parts[1] || code;
    if (display.length > 120) {
      throw new HttpError(400, 'OBX-3 analit adı en fazla 120 karakter olabilir.');
    }
    const value = (f[5] || '').trim();
    if (!value || value.length > 120) {
      throw new HttpError(400, 'OBX-5 sonuç değeri zorunludur (en fazla 120 karakter).');
    }
    const unit = ((f[6] || '').split('^')[0] || '').trim();
    if (unit.length > 30) throw new HttpError(400, 'OBX-6 birim en fazla 30 karakter olabilir.');
    const referenceRange = (f[7] || '').trim() || null;
    if (referenceRange && referenceRange.length > 60) {
      throw new HttpError(400, 'OBX-7 referans aralığı en fazla 60 karakter olabilir.');
    }
    const rawFlag = (f[8] || 'N').trim().toUpperCase();
    const flag = rawFlag === 'HH' || rawFlag === 'AA'
      ? 'HH'
      : rawFlag === 'LL'
        ? 'LL'
        : rawFlag === 'H' || rawFlag === 'L'
          ? rawFlag
          : 'N';
    const criticalFlag = evaluateCriticalLab({ analyteCode: code, display, value, flag: rawFlag, critical: false });
    return { code, display, value, unit, referenceRange, flag, criticalFlag };
  });

  return {
    sendingApp,
    messageTimestamp,
    controlId,
    patientIdentifier,
    orderIdentifier,
    testCode,
    testDisplay,
    observations
  };
}

function buildHl7Ack(controlId, ackCode, error = null) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safeId = String(controlId || '').replace(/\|/g, '\\F\\').replace(/[\r\n]/g, '');
  let ack = `MSH|^~\\&|NOVA-HBYS|HOSPITAL|LAB-SYSTEM|LAB|${ts}||ACK^R01|ACK-${crypto.randomUUID().slice(0, 8)}|P|2.5.1\rMSA|${ackCode}|${safeId}`;
  if (error) {
    ack += '|' + String(error).replace(/\|/g, '\\F\\').replace(/[\r\n]/g, '');
  }
  return ack + '\r';
}

class HttpError extends Error {
  constructor(statusCode, message, extra = null) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

// --- AUDIT HASH CHAIN ENGINE ---

function computeCanonicalAuditPayload({ previousHash, id, occurredAt, username, role, action, entityType, entityId, details }) {
  return [
    previousHash,
    String(id),
    occurredAt,
    username,
    role,
    action,
    entityType,
    entityId === null || entityId === undefined ? '' : String(entityId),
    JSON.stringify(details ?? {})
  ].join('|');
}

function verifyAuditChain(eventsAscending) {
  let expectedPrevious = '0'.repeat(64);
  let verifiedCount = 0;
  let chainValid = true;
  let brokenEventId = null;

  for (const evt of eventsAscending) {
    const recomputedCanonical = computeCanonicalAuditPayload({
      previousHash: expectedPrevious,
      id: evt.id,
      occurredAt: evt.occurredAt,
      username: evt.username,
      role: evt.role,
      action: evt.action,
      entityType: evt.entityType,
      entityId: evt.entityId,
      details: evt.details ?? JSON.parse(evt.detailsJson || '{}')
    });
    const recomputedHash = crypto.createHash('sha256').update(recomputedCanonical, 'utf8').digest('hex');
    const prevMatches = evt.previousHash === expectedPrevious;
    const canonicalMatches = evt.canonicalPayload === recomputedCanonical;
    const hashMatches = evt.eventHash === recomputedHash;

    if (chainValid && (!prevMatches || !canonicalMatches || !hashMatches)) {
      chainValid = false;
      brokenEventId = evt.id;
    }
    expectedPrevious = evt.eventHash;
    verifiedCount++;
  }

  return { chainValid, verifiedCount, brokenEventId };
}

// --- SYNTHETIC DATASET & CONNECTORS ---

function createConnectorsConfig(port = 8088) {
  return {
    medula: {
      name: 'SGK MEDULA Gateway',
      institution: 'T.C. Sosyal Güvenlik Kurumu',
      type: 'SOAP / WSDL 3.2 & REST GSS',
      protocol: 'SOAP / WSDL 3.2 & REST GSS',
      status: 'ONLINE',
      pingMs: 24,
      latencyMs: 24,
      uptime: '99.98%',
      activeProvisionsToday: 142,
      rejectedClaims: 1,
      endpoint: 'https://medula.sgk.gov.tr/medula/hastane/gss/v3',
      version: 'MEDULA-V3.4.1'
    },
    mhrs: {
      name: 'MHRS Gateway (Randevu)',
      institution: 'T.C. Sağlık Bakanlığı',
      type: 'REST v2 / HL7 FHIR Bridge',
      protocol: 'REST v2 / HL7 FHIR Bridge',
      status: 'ONLINE',
      pingMs: 18,
      latencyMs: 18,
      uptime: '99.95%',
      activeProvisionsToday: 88,
      rejectedClaims: 0,
      endpoint: 'https://mhrs.saglik.gov.tr/api/v2/kurum-entegrasyon',
      version: 'MHRS-Bakanlik-2.6'
    },
    ulak: {
      name: 'ULAK 112 Acil Vaka & ASOS Ağı',
      institution: 'T.C. Sağlık Bakanlığı Acil Sağlık Hizmetleri Genel Müdürlüğü',
      type: 'WebSockets / Ulak Secure Message Protocol v4',
      protocol: 'WebSockets / Ulak Secure Message Protocol v4',
      status: 'ONLINE',
      pingMs: 12,
      latencyMs: 12,
      uptime: '100.00%',
      activeProvisionsToday: 26,
      rejectedClaims: 0,
      endpoint: 'wss://ulak112.saglik.gov.tr/live/vaka-transfer',
      version: 'ULAK-ASOS-4.2'
    },
    uss: {
      name: 'USS / e-Nabız Gateway',
      institution: 'T.C. Sağlık Bakanlığı Ulusal Sağlık Sistemi',
      type: 'SOAP / XML Paket 101-401 & REST e-Nabız',
      protocol: 'SOAP / XML Paket 101-401 & REST e-Nabız',
      status: 'ONLINE',
      pingMs: 31,
      latencyMs: 31,
      uptime: '99.91%',
      activeProvisionsToday: 320,
      rejectedClaims: 2,
      endpoint: 'https://uss.saglik.gov.tr/SYS/SYSIslemleri.asmx',
      version: 'USS-Paket-v4.8'
    },
    its: {
      name: 'İTS / ÜTS (İlaç ve Ürün Takip Sistemi)',
      institution: 'T.C. Türkiye İlaç ve Tıbbi Cihaz Kurumu (TİTCK)',
      type: 'REST DataMatrix GS1-128 Tekil Takip',
      protocol: 'REST DataMatrix GS1-128 Tekil Takip',
      status: 'ONLINE',
      pingMs: 29,
      latencyMs: 29,
      uptime: '99.89%',
      activeProvisionsToday: 64,
      rejectedClaims: 0,
      endpoint: 'https://its.saglik.gov.tr/v1/tekil-takip',
      version: 'ITS-GS1-128-v2.0'
    },
    lis: {
      name: 'LIS HL7 Cihaz Entegratörü',
      institution: 'Merkez Laboratuvar Sysmex & Cobas Otomasyonu',
      type: 'HL7 v2.5.1 ORU^R01 / MLLP & HTTP Bridge',
      protocol: 'HL7 v2.5.1 ORU^R01 / MLLP & HTTP Bridge',
      status: 'ONLINE',
      pingMs: 8,
      latencyMs: 8,
      uptime: '100.00%',
      activeProvisionsToday: 215,
      rejectedClaims: 0,
      endpoint: `http://localhost:${port}/api/hl7/oru`,
      version: 'HL7-v2.5.1-ORU-Bridge'
    },
    pacs: {
      name: 'PACS / DICOMweb Arşivi',
      institution: 'Radyoloji Görüntüleme ve Arşivleme Sistemi',
      type: 'DICOM WADO-RS / QIDO-RS / C-STORE',
      protocol: 'DICOM WADO-RS / QIDO-RS / C-STORE',
      status: 'ONLINE',
      pingMs: 15,
      latencyMs: 15,
      uptime: '99.97%',
      activeProvisionsToday: 48,
      rejectedClaims: 0,
      endpoint: `http://localhost:${port}/api/radiology-reports`,
      version: 'DICOM-PS3.18-WADO-RS'
    }
  };
}

function maskTckn(tckn) {
  const s = String(tckn || '');
  if (s.length < 6) return '***';
  return `${s.slice(0, 3)}*****${s.slice(-3)}`;
}

function createInitialDataset() {
  const now = new Date();
  const isoAgo = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
  const dateAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString().split('T')[0];

  const patients = [
    { id: 1, mrn: 'HB-000101', givenName: 'Ayşe', familyName: 'Demir', birthDate: '1988-04-12', sex: 'F', phone: '0532 555 10 01', bloodType: 'A+', tckn: '28491028472', chronic: 'Tip 2 Diyabet', allergies: 'Penisilin', active: true, createdAt: isoAgo(14400) },
    { id: 2, mrn: 'HB-000102', givenName: 'Mehmet', familyName: 'Kaya', birthDate: '1974-09-23', sex: 'M', phone: '0542 555 10 02', bloodType: '0+', tckn: '49281039481', chronic: 'Hipertansiyon, KAH', allergies: 'Yok', active: true, createdAt: isoAgo(14000) },
    { id: 3, mrn: 'HB-000103', givenName: 'Elif', familyName: 'Yıldız', birthDate: '2001-01-05', sex: 'F', phone: '0555 555 10 03', bloodType: 'B+', tckn: '10394829104', chronic: 'Astım', allergies: 'Aspirin', active: true, createdAt: isoAgo(12000) },
    { id: 4, mrn: 'HB-000104', givenName: 'Ahmet', familyName: 'Yılmaz', birthDate: '1962-11-18', sex: 'M', phone: '0533 555 10 04', bloodType: 'AB+', tckn: '39481029384', chronic: 'KOAH, Sigara öyküsü', allergies: 'Yok', active: true, createdAt: isoAgo(10000) },
    { id: 5, mrn: 'HB-000105', givenName: 'Zeynep', familyName: 'Çelik', birthDate: '1984-06-30', sex: 'F', phone: '0544 555 10 05', bloodType: 'A-', tckn: '58291039482', chronic: 'Hipotiroidi (Hashimoto)', allergies: 'Sulfa', active: true, createdAt: isoAgo(9500) },
    { id: 6, mrn: 'HB-000106', givenName: 'Caner', familyName: 'Öztürk', birthDate: '1997-03-14', sex: 'M', phone: '0535 555 10 06', bloodType: '0-', tckn: '67291048291', chronic: 'Yok', allergies: 'Yok', active: true, createdAt: isoAgo(8000) },
    { id: 7, mrn: 'HB-000107', givenName: 'Fatma', familyName: 'Arslan', birthDate: '1955-08-20', sex: 'F', phone: '0546 555 10 07', bloodType: 'B-', tckn: '82910482910', chronic: 'Osteoporoz', allergies: 'Yok', active: true, createdAt: isoAgo(7500) },
    { id: 8, mrn: 'HB-000108', givenName: 'Burak', familyName: 'Koç', birthDate: '1979-12-03', sex: 'M', phone: '0536 555 10 08', bloodType: '0+', tckn: '91820491823', chronic: 'Yok', allergies: 'Yok', active: true, createdAt: isoAgo(6000) },
    { id: 9, mrn: 'HB-000109', givenName: 'Hatice', familyName: 'Doğan', birthDate: '1993-05-17', sex: 'F', phone: '0552 555 10 09', bloodType: 'A+', tckn: '71928301928', chronic: 'Gebelik 24. Hafta', allergies: 'Yok', active: true, createdAt: isoAgo(5000) },
    { id: 10, mrn: 'HB-000110', givenName: 'Mustafa', familyName: 'Şahin', birthDate: '1967-02-28', sex: 'M', phone: '0538 555 10 10', bloodType: 'AB-', tckn: '48192039481', chronic: 'KAH, Hiperlipidemi', allergies: 'Yok', active: true, createdAt: isoAgo(4000) },
    { id: 11, mrn: 'HB-000111', givenName: 'Selin', familyName: 'Aydın', birthDate: '2007-09-12', sex: 'F', phone: '0543 555 10 11', bloodType: 'B+', tckn: '30192840192', chronic: 'Yok', allergies: 'Yok', active: true, createdAt: isoAgo(3000) },
    { id: 12, mrn: 'HB-000112', givenName: 'Kerem', familyName: 'Polat', birthDate: '2018-07-04', sex: 'M', phone: '0539 555 10 12', bloodType: '0+', tckn: '20192849102', chronic: 'Rutin Çocuk İzlem', allergies: 'Yok', active: true, createdAt: isoAgo(2000) },
    { id: 13, mrn: 'HB-000113', givenName: 'Tolga', familyName: 'Erdem', birthDate: '1990-10-11', sex: 'M', phone: '0553 555 10 13', bloodType: '0-', tckn: '61928301923', chronic: 'Yok', allergies: 'Yok', active: true, createdAt: isoAgo(1200) },
    { id: 14, mrn: 'HB-000114', givenName: 'Gamze', familyName: 'Aksoy', birthDate: '1982-01-25', sex: 'F', phone: '0534 555 10 14', bloodType: 'AB+', tckn: '81920394821', chronic: 'Migren', allergies: 'Yok', active: true, createdAt: isoAgo(800) },
    { id: 15, mrn: 'HB-000115', givenName: 'Kemal', familyName: 'Eren', birthDate: '2004-11-09', sex: 'M', phone: '0545 555 10 15', bloodType: 'A+', tckn: '90129384912', chronic: 'Yok', allergies: 'Yok', active: true, createdAt: isoAgo(400) }
  ];

  const encounters = [
    { id: 1, patientId: 1, encounterType: 'Outpatient', status: 'Open', chiefComplaint: 'Kontrol muayenesi, HbA1c takibi (MEDULA Provizyonlu)', openedAt: isoAgo(120), closedAt: null, externalRef: 'SEED-ENCOUNTER-101', medulaTakipNo: '260305108492', sysTakipNo: 'SYS-2026-TR-8491', mhrsRandevuId: 'MHRS-2026-8001', ulakProtokolNo: null },
    { id: 2, patientId: 2, encounterType: 'Inpatient', status: 'Admitted', chiefComplaint: 'Göğüs sıkışması gözlemi ve kardiyak takip', openedAt: isoAgo(1440), closedAt: null, externalRef: 'SEED-ENCOUNTER-102', medulaTakipNo: '260305108493', sysTakipNo: 'SYS-2026-TR-8492', mhrsRandevuId: null, ulakProtokolNo: null },
    { id: 3, patientId: 10, encounterType: 'Emergency', status: 'Admitted', chiefComplaint: 'Akut Anterior MI şüphesi, retrosternal baskı (ULAK 112 Kırmızı Alan)', openedAt: isoAgo(45), closedAt: null, externalRef: 'SEED-ENCOUNTER-103', medulaTakipNo: '260305108494', sysTakipNo: 'SYS-2026-TR-8494', mhrsRandevuId: null, ulakProtokolNo: 'ULAK-112-901' },
    { id: 4, patientId: 13, encounterType: 'Emergency', status: 'Admitted', chiefComplaint: 'Trafik kazası, toraks travması (ULAK 112 Kırmızı Alan)', openedAt: isoAgo(90), closedAt: null, externalRef: 'SEED-ENCOUNTER-104', medulaTakipNo: '260305108495', sysTakipNo: 'SYS-2026-TR-8495', mhrsRandevuId: null, ulakProtokolNo: 'ULAK-112-902' },
    { id: 5, patientId: 6, encounterType: 'Outpatient', status: 'Open', chiefComplaint: 'Sağ diz burkulması, hareket kısıtlılığı (MHRS randevulu)', openedAt: isoAgo(30), closedAt: null, externalRef: 'SEED-ENCOUNTER-105', medulaTakipNo: '260305108496', sysTakipNo: 'SYS-2026-TR-8496', mhrsRandevuId: 'MHRS-2026-8004', ulakProtokolNo: null },
    { id: 6, patientId: 4, encounterType: 'Outpatient', status: 'Open', chiefComplaint: 'KOAH alevlenme, dispne ve öksürük (MHRS randevulu)', openedAt: isoAgo(60), closedAt: null, externalRef: 'SEED-ENCOUNTER-106', medulaTakipNo: '260305108497', sysTakipNo: 'SYS-2026-TR-8497', mhrsRandevuId: 'MHRS-2026-8002', ulakProtokolNo: null },
    { id: 7, patientId: 8, encounterType: 'Emergency', status: 'Admitted', chiefComplaint: 'Şiddetli sağ alt kadran ağrısı, bulantı (ULAK 112 Sarı Alan)', openedAt: isoAgo(40), closedAt: null, externalRef: 'SEED-ENCOUNTER-107', medulaTakipNo: '260305108498', sysTakipNo: 'SYS-2026-TR-8498', mhrsRandevuId: null, ulakProtokolNo: 'ULAK-112-904' },
    { id: 8, patientId: 5, encounterType: 'Outpatient', status: 'Open', chiefComplaint: 'Rutin tiroid paneli ve USG kontrolü', openedAt: isoAgo(180), closedAt: null, externalRef: 'SEED-ENCOUNTER-108', medulaTakipNo: '260305108499', sysTakipNo: 'SYS-2026-TR-8499', mhrsRandevuId: null, ulakProtokolNo: null }
  ];

  // Fixed seed collision: Bed #4 (201-A) is Available; Bed #8 (KIRMIZI-1) is Occupied by encounterId 3
  const beds = [
    { id: 1, ward: 'Dahiliye', room: '101', bedNo: '101-A', status: 'Occupied', currentEncounterId: 2 },
    { id: 2, ward: 'Dahiliye', room: '101', bedNo: '101-B', status: 'Available', currentEncounterId: null },
    { id: 3, ward: 'Dahiliye', room: '102', bedNo: '102-A', status: 'Cleaning', currentEncounterId: null },
    { id: 4, ward: 'Kardiyoloji', room: '201', bedNo: '201-A', status: 'Available', currentEncounterId: null },
    { id: 5, ward: 'Kardiyoloji', room: '201', bedNo: '201-B', status: 'Available', currentEncounterId: null },
    { id: 6, ward: 'Yoğun Bakım', room: 'YB-1', bedNo: 'YB-01', status: 'Occupied', currentEncounterId: 4 },
    { id: 7, ward: 'Yoğun Bakım', room: 'YB-1', bedNo: 'YB-02', status: 'Available', currentEncounterId: null },
    { id: 8, ward: 'Acil Gözlem', room: 'ACIL-1', bedNo: 'KIRMIZI-1', status: 'Occupied', currentEncounterId: 3 },
    { id: 9, ward: 'Acil Gözlem', room: 'ACIL-1', bedNo: 'SARI-1', status: 'Occupied', currentEncounterId: 7 },
    { id: 10, ward: 'Acil Gözlem', room: 'ACIL-1', bedNo: 'SARI-2', status: 'Available', currentEncounterId: null },
    { id: 11, ward: 'Ortopedi', room: '301', bedNo: '301-A', status: 'Available', currentEncounterId: null },
    { id: 12, ward: 'Ortopedi', room: '301', bedNo: '301-B', status: 'Available', currentEncounterId: null }
  ];

  const admissions = [
    { id: 1, encounterId: 2, bedId: 1, admittedAt: isoAgo(1440), dischargedAt: null, status: 'Admitted' },
    { id: 2, encounterId: 3, bedId: 8, admittedAt: isoAgo(45), dischargedAt: null, status: 'Admitted' },
    { id: 3, encounterId: 4, bedId: 6, admittedAt: isoAgo(90), dischargedAt: null, status: 'Admitted' },
    { id: 4, encounterId: 7, bedId: 9, admittedAt: isoAgo(40), dischargedAt: null, status: 'Admitted' }
  ];

  const bedTransfers = [
    {
      id: 1,
      admissionId: 3,
      fromBedId: 8,
      fromBedNo: 'KIRMIZI-1',
      fromWard: 'Acil Gözlem',
      toBedId: 6,
      toBedNo: 'YB-01',
      toWard: 'Yoğun Bakım',
      transferredBy: 'Hemşire Elif Yıldız',
      reason: 'Acil stabilizasyon sonrası Yoğun Bakım devri',
      transferredAt: isoAgo(75)
    }
  ];

  const drugs = [
    { id: 1, code: 'DEMO-0001', atc: 'N02BE01', name: 'Parasetamol 500 mg', genericName: 'Paracetamol', allergyGroup: null, form: 'Tablet', stock: 240, minStock: 50, unitPrice: 1.25, barcode: '8699525010012', utsCode: 'UTS-DRG-01', active: true },
    { id: 2, code: 'DEMO-0002', atc: 'J01CR02', name: 'Amoksisilin-Klavulanat 1000 mg', genericName: 'Amoxicillin / Clavulanic Acid', allergyGroup: 'Penicillin', form: 'Film Tablet', stock: 86, minStock: 30, unitPrice: 4.80, barcode: '8699525010029', utsCode: 'UTS-DRG-02', active: true },
    { id: 3, code: 'DEMO-0003', atc: 'B05BB01', name: 'Serum Fizyolojik %0.9 500 mL', genericName: 'Sodium Chloride %0.9', allergyGroup: null, form: 'Flakon', stock: 18, minStock: 20, unitPrice: 7.50, barcode: '8699525010036', utsCode: 'UTS-DRG-03', active: true },
    { id: 4, code: 'DEMO-0004', atc: 'R03AC02', name: 'Salbutamol 2.5 mg Nebül', genericName: 'Salbutamol', allergyGroup: null, form: 'Nebül', stock: 65, minStock: 15, unitPrice: 3.20, barcode: '8699525010043', utsCode: 'UTS-DRG-04', active: true },
    { id: 5, code: 'DEMO-0005', atc: 'B01AB05', name: 'Enoksaparin Sodyum 4000 IU', genericName: 'Enoxaparin Sodium', allergyGroup: null, form: 'Hazır Enjektör', stock: 12, minStock: 15, unitPrice: 42.00, barcode: '8699525010050', utsCode: 'UTS-DRG-05', active: true },
    { id: 6, code: 'DEMO-0006', atc: 'A10BA02', name: 'Metformin HCl 1000 mg', genericName: 'Metformin', allergyGroup: null, form: 'Tablet', stock: 180, minStock: 40, unitPrice: 2.10, barcode: '8699525010067', utsCode: 'UTS-DRG-06', active: true },
    { id: 7, code: 'DEMO-0007', atc: 'A10AE04', name: 'İnsülin Glargin 100 U/mL SoloStar', genericName: 'Insulin Glargine', allergyGroup: null, form: 'Kartuş Kalem', stock: 35, minStock: 10, unitPrice: 115.00, barcode: '8699525010074', utsCode: 'UTS-DRG-07', active: true },
    { id: 8, code: 'DEMO-0008', atc: 'B01AC06', name: 'Asetilsalisilik Asit 100 mg (Coraspin)', genericName: 'Acetylsalicylic Acid (Aspirin)', allergyGroup: 'NSAID', form: 'Enterik Tablet', stock: 310, minStock: 60, unitPrice: 1.10, barcode: '8699525010081', utsCode: 'UTS-DRG-08', active: true },
    { id: 9, code: 'DEMO-0009', atc: 'A02BC02', name: 'Pantoprazol 40 mg İv Flakon', genericName: 'Pantoprazole', allergyGroup: null, form: 'Liyofilize Flakon', stock: 52, minStock: 20, unitPrice: 18.50, barcode: '8699525010098', utsCode: 'UTS-DRG-09', active: true },
    { id: 10, code: 'DEMO-0010', atc: 'J01DD04', name: 'Seftriakson 1g İv Flakon', genericName: 'Ceftriaxone', allergyGroup: 'Beta-Lactam', form: 'Flakon', stock: 45, minStock: 15, unitPrice: 24.00, barcode: '8699525010104', utsCode: 'UTS-DRG-10', active: true },
    { id: 11, code: 'DEMO-0011', atc: 'H02AB02', name: 'Deksametazon 8 mg/2 mL', genericName: 'Dexamethasone', allergyGroup: null, form: 'Ampul', stock: 88, minStock: 20, unitPrice: 8.90, barcode: '8699525010111', utsCode: 'UTS-DRG-11', active: true },
    { id: 12, code: 'DEMO-0012', atc: 'C09AA02', name: 'Enalapril 10 mg', genericName: 'Enalapril', allergyGroup: null, form: 'Tablet', stock: 120, minStock: 30, unitPrice: 3.50, barcode: '8699525010128', utsCode: 'UTS-DRG-12', active: true },
    { id: 13, code: 'DEMO-0013', atc: 'H03AA01', name: 'Levotiroksin Sodyum 100 mcg', genericName: 'Levothyroxine Sodium', allergyGroup: null, form: 'Tablet', stock: 140, minStock: 30, unitPrice: 4.20, barcode: '8699525010135', utsCode: 'UTS-DRG-13', active: true },
    { id: 14, code: 'DEMO-0014', atc: 'M01AB05', name: 'Diklofenak Sodyum 75 mg', genericName: 'Diclofenac Sodium', allergyGroup: 'NSAID', form: 'Ampul', stock: 75, minStock: 20, unitPrice: 5.40, barcode: '8699525010142', utsCode: 'UTS-DRG-14', active: true },
    { id: 15, code: 'DEMO-0015', atc: 'J01EE01', name: 'Trimetoprim-Sulfametoksazol 800/160 mg', genericName: 'Sulfamethoxazole / Trimethoprim', allergyGroup: 'Sulfonamide', form: 'Tablet', stock: 60, minStock: 15, unitPrice: 3.90, barcode: '8699525010159', utsCode: 'UTS-DRG-15', active: true }
  ];

  const stockMovements = [
    { id: 1, drugId: 8, prescriptionId: 2, movementType: 'DISPENSE', qtyDelta: -10, referenceNo: 'RX-2', actor: 'pharmacist', createdAt: isoAgo(34) },
    { id: 2, drugId: 5, prescriptionId: 2, movementType: 'DISPENSE', qtyDelta: -5, referenceNo: 'RX-2', actor: 'pharmacist', createdAt: isoAgo(34) }
  ];

  const orders = [
    { id: 1, encounterId: 1, orderType: 'LAB', codeSystem: 'LOINC', code: '718-7', description: 'Hemoglobin & Tam Kan Sayımı (Hemogram)', orderedBy: 'Dr. Mehmet Kaya', status: 'Verified', priority: 'R', clinicalNote: 'Rutin kontrol', createdAt: isoAgo(100), updatedAt: isoAgo(50), externalRef: 'SEED-ORDER-001', icd10: 'E11.9', sutCode: '700.120' },
    { id: 2, encounterId: 1, orderType: 'LAB', codeSystem: 'LOINC', code: '4548-4', description: 'HbA1c (Glike Hemoglobin)', orderedBy: 'Dr. Mehmet Kaya', status: 'Verified', priority: 'R', clinicalNote: '3 aylık glisemik kontrol', createdAt: isoAgo(100), updatedAt: isoAgo(50), externalRef: 'SEED-ORDER-002', icd10: 'E11.9', sutCode: '701.110' },
    { id: 3, encounterId: 3, orderType: 'LAB', codeSystem: 'LOINC', code: '10839-9', description: 'Kardiyak Troponin I (Yüksek Duyarlılıklı)', orderedBy: 'Dr. Ahmet Öz (Acil)', status: 'Resulted', priority: 'U', clinicalNote: 'Göğüs ağrısı acil kardiyak belirteç', createdAt: isoAgo(40), updatedAt: isoAgo(20), externalRef: 'SEED-ORDER-003', icd10: 'I21.0', sutCode: '701.350' },
    { id: 4, encounterId: 3, orderType: 'PROCEDURE', codeSystem: 'SUT', code: '704.220', description: '12 Derivasyonlu Elektrokardiyografi (EKG)', orderedBy: 'Dr. Ahmet Öz (Acil)', status: 'Verified', priority: 'U', clinicalNote: 'V1-V4 ST elevasyonu izlendi', createdAt: isoAgo(42), updatedAt: isoAgo(35), externalRef: 'SEED-ORDER-004', icd10: 'I21.0', sutCode: '704.220' },
    { id: 5, encounterId: 4, orderType: 'RAD', codeSystem: 'SUT', code: '804.100', description: 'Toraks ve Beyin Bilgisayarlı Tomografi (BT)', orderedBy: 'Dr. Ahmet Öz (Acil)', status: 'Resulted', priority: 'U', clinicalNote: 'Künt travma acil tarama', createdAt: isoAgo(80), updatedAt: isoAgo(30), externalRef: 'SEED-ORDER-005', icd10: 'S29.9', sutCode: '804.100' },
    { id: 6, encounterId: 6, orderType: 'RAD', codeSystem: 'SUT', code: '802.130', description: 'PA Akciğer Grafisi (Dijital Röntgen)', orderedBy: 'Dr. Canan Ak (Göğüs)', status: 'Verified', priority: 'R', clinicalNote: 'KOAH alevlenme kontrol', createdAt: isoAgo(55), updatedAt: isoAgo(25), externalRef: 'SEED-ORDER-006', icd10: 'J44.1', sutCode: '802.130' },
    { id: 7, encounterId: 5, orderType: 'RAD', codeSystem: 'SUT', code: '804.500', description: 'Sağ Diz Manyetik Rezonans Görüntüleme (MR)', orderedBy: 'Op. Dr. Barış Güven', status: 'Resulted', priority: 'R', clinicalNote: 'Menisküs değerlendirme', createdAt: isoAgo(25), updatedAt: isoAgo(10), externalRef: 'SEED-ORDER-007', icd10: 'M23.2', sutCode: '804.500' },
    { id: 8, encounterId: 7, orderType: 'LAB', codeSystem: 'LOINC', code: '6690-2', description: 'Lökosit / WBC Sayımı ve CRP', orderedBy: 'Dr. Ahmet Öz (Acil)', status: 'InProgress', priority: 'U', clinicalNote: 'Akut apandisit şüphesi', createdAt: isoAgo(35), updatedAt: isoAgo(35), externalRef: 'SEED-ORDER-008', icd10: 'K35.8', sutCode: '700.120' },
    { id: 9, encounterId: 2, orderType: 'RAD', codeSystem: 'SUT', code: '804.600', description: 'Lomber Spinal Manyetik Rezonans (MR)', orderedBy: 'Dr. Mehmet Kaya', status: 'Verified', priority: 'R', clinicalNote: 'Lomber disk değerlendirme', createdAt: isoAgo(1200), updatedAt: isoAgo(1100), externalRef: 'SEED-ORDER-009', icd10: 'M51.2', sutCode: '804.600' },
    { id: 10, encounterId: 3, orderType: 'CONSULT', codeSystem: 'SUT', code: '520.050', description: 'Acil Kardiyoloji Konsültasyonu', orderedBy: 'Dr. Mehmet Kaya', status: 'Submitted', priority: 'S', clinicalNote: 'Primer PCI değerlendirmesi talep edildi', createdAt: isoAgo(38), updatedAt: isoAgo(38), externalRef: 'SEED-ORDER-010', icd10: 'I21.0', sutCode: '520.050' }
  ];

  const labResults = [
    { id: 1, orderId: 1, analyteCode: '718-7', display: 'Hemoglobin (HGB)', value: '13.8', unit: 'g/dL', referenceRange: '12.0 - 16.0', flag: 'N', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(50) },
    { id: 2, orderId: 1, analyteCode: '6690-2', display: 'Lökosit (WBC)', value: '7.4', unit: '10^3/uL', referenceRange: '4.0 - 10.5', flag: 'N', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(50) },
    { id: 3, orderId: 1, analyteCode: '777-3', display: 'Trombosit (PLT)', value: '245', unit: '10^3/uL', referenceRange: '150 - 450', flag: 'N', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(50) },
    { id: 4, orderId: 2, analyteCode: '4548-4', display: 'Glike Hemoglobin (HbA1c)', value: '7.8', unit: '%', referenceRange: '4.0 - 6.0', flag: 'H', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(50) },
    { id: 5, orderId: 2, analyteCode: '2345-7', display: 'Açlık Kan Şekeri (Glukoz)', value: '154', unit: 'mg/dL', referenceRange: '70 - 100', flag: 'H', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(50) },
    { id: 6, orderId: 3, analyteCode: '10839-9', display: 'Kardiyak Troponin I (hs-cTnI)', value: '1.92', unit: 'ng/mL', referenceRange: '0.00 - 0.04', flag: 'HH', criticalFlag: true, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(20) },
    { id: 7, orderId: 3, analyteCode: '2160-0', display: 'Serum Kreatinin', value: '1.05', unit: 'mg/dL', referenceRange: '0.70 - 1.20', flag: 'N', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(20) },
    { id: 8, orderId: 3, analyteCode: '48065-7', display: 'D-Dimer', value: '310', unit: 'ng/mL', referenceRange: '0 - 500', flag: 'N', criticalFlag: false, criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null, resultedAt: isoAgo(20) }
  ];

  const radiologyReports = [
    { id: 1, orderId: 6, code: '802.130', description: 'PA Akciğer Grafisi', modality: 'CR', impression: 'Bilateral parankimal aktif infiltrasyon izlenmedi. Sağ parakardiyak alanda minimal bronkovasküler belirginleşme mevcuttur. Kardiyotorasik oran fizyolojik sınırlardadır.', reportText: 'KLİNİK BİLGİ: KOAH alevlenme, dispne.\n\nBULGULAR: Trakea orta hattadır. Kalp konturları ve boyutu normaldir. Her iki hemitoraksta havalanma simetriktir. Plevral effüzyon veya pnömotoraks lehine bulgu saptanmamıştır. Kostodiafragmatik sinüsler açıktır.', reportedBy: 'Uzm. Dr. Burak Koç', reportedAt: isoAgo(25), dicomSeriesUid: '1.2.840.10008.5.1.4.1.1.1.20261105.1' },
    { id: 2, orderId: 5, code: '804.100', description: 'Toraks ve Beyin BT', modality: 'CT', impression: 'Toraks ve Beyin BT incelemesinde akut epidural/subdural hematom ya da kosta fraktürü izlenmemiştir. Sol alt lobda hafif travmatik kontüzyon alanı saptanmıştır.', reportText: 'KLİNİK BİLGİ: Araç içi trafik kazası, künt toraks travması.\n\nBEYİN BT: İntrakranial kanama, kitle etkisi veya orta hat şifti izlenmedi. Kemik yapılar sağlamdır.\n\nTORAKS BT: Sol akciğer bazal segmentte 12x15 mm boyutunda buzlu cam görünümünde kontüzyonel dansite artışı dikkati çekmiştir. Pnömotoraks izlenmemiştir.', reportedBy: 'Uzm. Dr. Burak Koç', reportedAt: isoAgo(30), dicomSeriesUid: '1.2.840.10008.5.1.4.1.1.2.20261105.2' },
    { id: 3, orderId: 7, code: '804.500', description: 'Sağ Diz MR', modality: 'MR', impression: 'Sağ diz medial menisküs arka boynuzunda artiküler yüzeye uzanım gösteren Grade 2B dejeneratif yırtık hattı. Ön çapraz bağda minimal distansiyon.', reportText: 'TEKNİK: Sagittal T1, T2, PD Fat-Sat ve Koronal PD Fat-Sat sekanslar incelenmiştir.\n\nBULGULAR: Medial menisküs arka boynuzunda Grade 2 yırtık ile uyumlu lineer hiperintensite izlenmektedir. Lateral menisküs konturları doğaldır. Eklem mesafesinde minimal effüzyon mevcuttur.', reportedBy: 'Uzm. Dr. Burak Koç', reportedAt: isoAgo(10), dicomSeriesUid: '1.2.840.10008.5.1.4.1.1.4.20261105.3' },
    { id: 4, orderId: 9, code: '804.600', description: 'Lomber Spinal MR', modality: 'MR', impression: 'L4-L5 düzeyinde geniş tabanlı santral disk protrüzyonu, tekal keseye hafif bası. Belirgin kök basısı izlenmedi.', reportText: 'BULGULAR: Lomber lordoz düzleşmiştir. L4-L5 disk yüksekliği ve sinyali azalmıştır. Tekal kese ön konturuna bası mevcuttur. Nöral foramenler açıktır.', reportedBy: 'Uzm. Dr. Burak Koç', reportedAt: isoAgo(1100), dicomSeriesUid: '1.2.840.10008.5.1.4.1.1.4.20261105.4' }
  ];

  const vitals = [
    {
      id: 1, encounterId: 1, ...computeNews2({ systolicBp: 124, diastolicBp: 78, heartRate: 76, respRate: 16, tempC: 36.6, spo2: 98, consciousness: 'A' }),
      recordedBy: 'Hemşire Elif Yıldız', recordedAt: isoAgo(110)
    },
    {
      id: 2, encounterId: 3, ...computeNews2({ systolicBp: 85, diastolicBp: 55, heartRate: 122, respRate: 26, tempC: 36.7, spo2: 89, consciousness: 'A' }),
      recordedBy: 'Hemşire Elif Yıldız', recordedAt: isoAgo(42)
    },
    {
      id: 3, encounterId: 4, ...computeNews2({ systolicBp: 94, diastolicBp: 62, heartRate: 114, respRate: 22, tempC: 36.4, spo2: 91, consciousness: 'V' }),
      recordedBy: 'Hemşire Elif Yıldız', recordedAt: isoAgo(85)
    }
  ];

  const clinicalNotes = [
    {
      id: 1, encounterId: 1, author: 'Uzm. Dr. Mehmet Kaya', authorRole: 'doctor', noteType: 'SOAP',
      subjective: 'Hasta 3 aylık poliklinik kontrolü için başvurdu. Sabah açlık kan şekerlerinin zaman zaman 150 mg/dL civarında seyrettiğini belirtiyor.',
      objective: 'Genel durumu iyi, koopere, oryante. TA 124/78 mmHg, Nb 76/dk. Akciğer ve kardiyak oskültasyon doğal.',
      assessment: 'E11.9 Tip 2 Diabetes Mellitus, komplikasyonsuz. HbA1c %7.8 (hedefin hafif üzerinde). Penisilin alerjisi mevcut.',
      plan: 'Metformin 1000 mg 2x1 ve İnsülin Glargin tedavisine devam, diyet uyumu eğitimi ve 3 ay sonra kontrol.',
      createdAt: isoAgo(95)
    },
    {
      id: 2, encounterId: 3, author: 'Uzm. Dr. Mehmet Kaya', authorRole: 'doctor', noteType: 'ACİL İZLEM',
      subjective: '45 dk önce başlayan sıkıştırıcı retrosternal göğüs ağrısı ve sol kola yayılım tarifliyor.',
      objective: 'Soğuk terleme mevcut. TA 85/55 mmHg, Nb 122/dk, SpO2 %89. EKG: V1-V4 ST elevasyonu. hs-cTnI 1.92 ng/mL.',
      assessment: 'I21.0 Akut Anterior Miyokard İnfarktüsü (STEMI). Yüksek NEWS2 skoru (11 - HIGH).',
      plan: 'Oksijen desteği, antiagregan/antikoagülan başlandı, Acil Kardiyoloji konsültasyonu ve primer anjiyoplasti hazırlığı.',
      createdAt: isoAgo(30)
    }
  ];

  const prescriptions = [
    {
      id: 1, encounterId: 1, prescribedBy: 'Dr. Mehmet Kaya', status: 'Pending', createdAt: isoAgo(40), dispensedAt: null, dispensedBy: null,
      medulaEreceteNo: '26A9BC4', tesisKodu: '11340001', overrideAllergy: false, overrideReason: null,
      items: [
        { drugId: 6, dosage: '1000 mg', frequency: 'Günde 2 kez', durationDays: 30, quantity: 60, dispensedQty: 0, usage: 'Yemeklerle birlikte', utsBarcode: '8699525010067' },
        { drugId: 7, dosage: '100 U/mL', frequency: 'Günde 1 kez (Akşam)', durationDays: 30, quantity: 2, dispensedQty: 0, usage: 'Her gün aynı saatte subkutan', utsBarcode: '8699525010074' }
      ]
    },
    {
      id: 2, encounterId: 3, prescribedBy: 'Dr. Ahmet Öz (Acil)', status: 'Dispensed', createdAt: isoAgo(35), dispensedAt: isoAgo(34), dispensedBy: 'Ecz. Selin Aydın',
      medulaEreceteNo: '26K89F1', tesisKodu: '11340001', overrideAllergy: false, overrideReason: null,
      items: [
        { drugId: 8, dosage: '100 mg', frequency: 'Günde 1 kez', durationDays: 10, quantity: 10, dispensedQty: 10, usage: 'Çiğneme tableti, acil antiagregan', utsBarcode: '8699525010081' },
        { drugId: 5, dosage: '4000 IU', frequency: 'Günde 1 kez', durationDays: 5, quantity: 5, dispensedQty: 5, usage: 'Subkutan antikoagülan', utsBarcode: '8699525010050' }
      ]
    },
    {
      id: 3, encounterId: 6, prescribedBy: 'Dr. Canan Ak (Göğüs)', status: 'Pending', createdAt: isoAgo(20), dispensedAt: null, dispensedBy: null,
      medulaEreceteNo: '26M44R9', tesisKodu: '11340001', overrideAllergy: false, overrideReason: null,
      items: [
        { drugId: 4, dosage: '2.5 mg', frequency: 'Günde 4 kez', durationDays: 7, quantity: 20, dispensedQty: 0, usage: 'Nebulizatör ile 15 dk', utsBarcode: '8699525010043' },
        { drugId: 2, dosage: '1000 mg', frequency: 'Günde 2 kez (12 saat ara)', durationDays: 10, quantity: 20, dispensedQty: 0, usage: 'Tok karnına bol su ile', utsBarcode: '8699525010029' }
      ]
    }
  ];

  const invoices = [
    {
      id: 1, encounterId: 1, invoiceNo: 'DEMO-INV-2026-001', payer: 'SGK', status: 'Paid', currency: 'TRY',
      totalAmount: 850.00, sgkShare: 835.00, patientShare: 15.00,
      medulaTakipNo: '260305108492', medulaDurum: 'Onaylandı (Kod: 0000)', createdAt: isoAgo(120), paidAt: isoAgo(115),
      lines: [
        { code: '520.010', description: 'İç Hastalıkları Uzman Muayenesi (SUT)', qty: 1, unitPrice: 350.00, lineTotal: 350.00 },
        { code: '700.120', description: 'Tam Kan Sayımı (Hemogram 18 Parametre)', qty: 1, unitPrice: 250.00, lineTotal: 250.00 },
        { code: '701.110', description: 'Glike Hemoglobin (HbA1c) Ölçümü', qty: 1, unitPrice: 250.00, lineTotal: 250.00 }
      ]
    },
    {
      id: 2, encounterId: 3, invoiceNo: 'DEMO-INV-2026-002', payer: 'SGK', status: 'Issued', currency: 'TRY',
      totalAmount: 4250.00, sgkShare: 4250.00, patientShare: 0.00,
      medulaTakipNo: '260305108494', medulaDurum: 'GSS İncelemesinde (Acil Kapsamı)', createdAt: isoAgo(30), paidAt: null,
      lines: [
        { code: '520.030', description: 'Acil Servis Kritik Müdahale & Resüsitasyon', qty: 1, unitPrice: 1800.00, lineTotal: 1800.00 },
        { code: '701.350', description: 'Kardiyak Yüksek Duyarlılıklı Troponin I', qty: 1, unitPrice: 850.00, lineTotal: 850.00 },
        { code: '704.220', description: 'Elektrokardiyografi (12 Derivasyon)', qty: 1, unitPrice: 400.00, lineTotal: 400.00 },
        { code: '510.120', description: 'Koroner Yoğun Bakım Günlük Yatak ve Bakım', qty: 1, unitPrice: 1200.00, lineTotal: 1200.00 }
      ]
    },
    {
      id: 3, encounterId: 4, invoiceNo: 'DEMO-INV-2026-003', payer: 'SGK', status: 'Issued', currency: 'TRY',
      totalAmount: 5800.00, sgkShare: 5800.00, patientShare: 0.00,
      medulaTakipNo: '260305108495', medulaDurum: 'Trafik Kazası Sigorta Girişi Yapıldı', createdAt: isoAgo(60), paidAt: null,
      lines: [
        { code: '804.100', description: 'Toraks ve Beyin Çok Kesitli Bilgisayarlı Tomografi', qty: 1, unitPrice: 3200.00, lineTotal: 3200.00 },
        { code: '520.030', description: 'Acil Travma Stabilizasyonu', qty: 1, unitPrice: 2600.00, lineTotal: 2600.00 }
      ]
    },
    {
      id: 4, encounterId: 6, invoiceNo: 'DEMO-INV-2026-004', payer: 'SGK', status: 'Issued', currency: 'TRY',
      totalAmount: 720.00, sgkShare: 705.00, patientShare: 15.00,
      medulaTakipNo: '260305108497', medulaDurum: 'Onaylandı (Kod: 0000)', createdAt: isoAgo(45), paidAt: null,
      lines: [
        { code: '520.010', description: 'Göğüs Hastalıkları Uzman Muayenesi', qty: 1, unitPrice: 350.00, lineTotal: 350.00 },
        { code: '802.130', description: 'PA Dijital Akciğer Grafisi', qty: 1, unitPrice: 370.00, lineTotal: 370.00 }
      ]
    }
  ];

  const vaccinations = [
    { id: 1, patientId: 3, vaccineCode: 'SKRS-A01', vaccineName: 'Tetanoz-Difteri (Td) Erişkin Aşısı', doseNo: 1, lotNo: 'LOT-TD-2026-A', administeredAt: isoAgo(10080), administeredBy: 'Hemşire Elif Yıldız', externalEventId: 'SEED-VAX-001' },
    { id: 2, patientId: 12, vaccineCode: 'SKRS-A04', vaccineName: 'KKK (Kızamık-Kızamıkçık-Kabakulak)', doseNo: 2, lotNo: 'LOT-KKK-26B', administeredAt: isoAgo(4320), administeredBy: 'Hemşire Elif Yıldız', externalEventId: 'SEED-VAX-002' },
    { id: 3, patientId: 1, vaccineCode: 'SKRS-A09', vaccineName: 'İnfluenza (Mevsimsel Grip) 4 Değerli', doseNo: 1, lotNo: 'LOT-FLU-26X', administeredAt: isoAgo(2880), administeredBy: 'Hemşire Fatma Çetin', externalEventId: 'SEED-VAX-003' },
    { id: 4, patientId: 4, vaccineCode: 'SKRS-A12', vaccineName: 'Pnömokok (Konjuge KPA-13)', doseNo: 1, lotNo: 'LOT-PNM-26K', administeredAt: isoAgo(1440), administeredBy: 'Hemşire Fatma Çetin', externalEventId: 'SEED-VAX-004' }
  ];

  const mhrsAppointments = [
    { id: 'MHRS-2026-8001', patientId: 1, patientRef: maskTckn('28491028472'), patientName: 'Ayşe Demir', polyclinic: 'İç Hastalıkları (Dahiliye)', doctor: 'Uzm. Dr. Mehmet Kaya', appointmentTime: '09:00', slotTime: '09:00', appointmentDate: dateAgo(0), status: 'Admitted', encounterId: 1, medulaTakipNo: '260305108492', note: 'Diyabet ve rutin biyokimya takibi' },
    { id: 'MHRS-2026-8002', patientId: 4, patientRef: maskTckn('39481029384'), patientName: 'Ahmet Yılmaz', polyclinic: 'Göğüs Hastalıkları', doctor: 'Uzm. Dr. Canan Ak', appointmentTime: '09:30', slotTime: '09:30', appointmentDate: dateAgo(0), status: 'Admitted', encounterId: 6, medulaTakipNo: '260305108497', note: 'KOAH kontrol ve solunum fonksiyon testi' },
    { id: 'MHRS-2026-8003', patientId: 5, patientRef: maskTckn('58291039482'), patientName: 'Zeynep Çelik', polyclinic: 'Endokrinoloji ve Metabolizma', doctor: 'Doç. Dr. Serdar Tekin', appointmentTime: '10:00', slotTime: '10:00', appointmentDate: dateAgo(0), status: 'Booked', encounterId: null, medulaTakipNo: null, note: 'Hashimoto tiroiditi hormon takibi' },
    { id: 'MHRS-2026-8004', patientId: 6, patientRef: maskTckn('67291048291'), patientName: 'Caner Öztürk', polyclinic: 'Ortopedi ve Travmatoloji', doctor: 'Op. Dr. Barış Güven', appointmentTime: '10:15', slotTime: '10:15', appointmentDate: dateAgo(0), status: 'Admitted', encounterId: 5, medulaTakipNo: '260305108496', note: 'Sağ diz travması ve MR istemi' },
    { id: 'MHRS-2026-8005', patientId: 9, patientRef: maskTckn('71928301928'), patientName: 'Hatice Doğan', polyclinic: 'Kadın Hastalıkları ve Doğum', doctor: 'Op. Dr. Sevil Şen', appointmentTime: '10:45', slotTime: '10:45', appointmentDate: dateAgo(0), status: 'Booked', encounterId: null, medulaTakipNo: null, note: '2. Düzey obstetrik ultrasonografi' },
    { id: 'MHRS-2026-8006', patientId: 14, patientRef: maskTckn('81920394821'), patientName: 'Gamze Aksoy', polyclinic: 'Nöroloji', doctor: 'Uzm. Dr. Aylin Yıldız', appointmentTime: '11:15', slotTime: '11:15', appointmentDate: dateAgo(0), status: 'Booked', encounterId: null, medulaTakipNo: null, note: 'Tedaviye dirençli migren atakları' },
    { id: 'MHRS-2026-8007', patientId: 11, patientRef: maskTckn('30192840192'), patientName: 'Selin Aydın', polyclinic: 'Kulak Burun Boğaz (KBB)', doctor: 'Op. Dr. Kaan Bulut', appointmentTime: '11:30', slotTime: '11:30', appointmentDate: dateAgo(0), status: 'Booked', encounterId: null, medulaTakipNo: null, note: 'Akut tonsillofarenjit ve burun tıkanıklığı' },
    { id: 'MHRS-2026-8008', patientId: 12, patientRef: maskTckn('20192849102'), patientName: 'Kerem Polat', polyclinic: 'Çocuk Sağlığı ve Hastalıkları', doctor: 'Uzm. Dr. Merve Tan', appointmentTime: '13:30', slotTime: '13:30', appointmentDate: dateAgo(0), status: 'Booked', encounterId: null, medulaTakipNo: null, note: '6 yaş gelişim ve okul öncesi aşı kontrolü' }
  ];

  const ulakCases = [
    {
      id: 'ULAK-112-901', patientId: 10, patientName: 'Mustafa Şahin (59E)', patientRef: maskTckn('48192039481'),
      teamCode: '34-KRT-112', ambulancePlate: '34 AS 1124', priority: 'Red', triageCode: 'RED', triageLevel: 'RED',
      triageTitle: 'KIRMIZI ALAN (Resüsitasyon / Kritik)',
      location: 'Kartal 1 No\'lu 112 İstasyonu',
      incidentSummary: 'Evde ani başlayan sıkıştırıcı retrosternal göğüs ağrısı, soğuk terleme, sol kola yayılım.',
      vitals: { bp: '85/55 mmHg', pulse: 122, spo2: 89, gcs: 14, bloodSugar: 178, temp: 36.7 },
      etaMinutes: 0, etrMinutes: 0, status: 'InHospital', encounterId: 3, bedAssigned: 'KIRMIZI-1',
      createdAt: isoAgo(48), arrivedAt: isoAgo(42)
    },
    {
      id: 'ULAK-112-902', patientId: 13, patientName: 'Tolga Erdem (36E)', patientRef: maskTckn('61928301923'),
      teamCode: '34-ACD-112', ambulancePlate: '34 AS 1198', priority: 'Red', triageCode: 'RED', triageLevel: 'RED',
      triageTitle: 'KIRMIZI ALAN (Çoklu Travma)',
      location: 'D-100 Karayolu Bostancı Mevkii',
      incidentSummary: 'D-100 karayolunda araç içi trafik kazası. Direksiyon çarpması, toraks kontüzyonu.',
      vitals: { bp: '90/60 mmHg', pulse: 115, spo2: 91, gcs: 12, bloodSugar: 110, temp: 36.4 },
      etaMinutes: 0, etrMinutes: 0, status: 'InHospital', encounterId: 4, bedAssigned: 'YB-01',
      createdAt: isoAgo(95), arrivedAt: isoAgo(88)
    },
    {
      id: 'ULAK-112-903', patientId: 7, patientName: 'Fatma Arslan (71K)', patientRef: maskTckn('82910482910'),
      teamCode: '34-KAD-112', ambulancePlate: '34 AS 1150', priority: 'Yellow', triageCode: 'YELLOW', triageLevel: 'YELLOW',
      triageTitle: 'SARI ALAN (Acil Gözlem)',
      location: 'Kadıköy 4 No\'lu 112 İstasyonu',
      incidentSummary: 'Islak zeminde düşme, sağ kalça bölgesinde şiddetli ağrı, hareket kısıtlılığı ve kısalık.',
      vitals: { bp: '135/85 mmHg', pulse: 82, spo2: 96, gcs: 15, bloodSugar: 124, temp: 36.8 },
      etaMinutes: 6, etrMinutes: 6, status: 'EnRoute', encounterId: null, bedAssigned: null,
      createdAt: isoAgo(18), arrivedAt: null
    },
    {
      id: 'ULAK-112-904', patientId: 8, patientName: 'Burak Koç (47E)', patientRef: maskTckn('91820491823'),
      teamCode: '34-SIS-112', ambulancePlate: '34 AS 1112', priority: 'Yellow', triageCode: 'YELLOW', triageLevel: 'YELLOW',
      triageTitle: 'SARI ALAN (Akut Batın)',
      location: 'Şişli Merkez 112 İstasyonu',
      incidentSummary: 'Sağ alt kadran ağrısı, defans, bulantı ve kusma (Akut apandisit ön tanısı).',
      vitals: { bp: '125/80 mmHg', pulse: 96, spo2: 98, gcs: 15, bloodSugar: 104, temp: 38.2 },
      etaMinutes: 0, etrMinutes: 0, status: 'InHospital', encounterId: 7, bedAssigned: 'SARI-1',
      createdAt: isoAgo(42), arrivedAt: isoAgo(38)
    },
    {
      id: 'ULAK-112-905', patientId: 15, patientName: 'Kemal Eren (22E)', patientRef: maskTckn('90129384912'),
      teamCode: '34-BES-112', ambulancePlate: '34 AS 1177', priority: 'Green', triageCode: 'GREEN', triageLevel: 'GREEN',
      triageTitle: 'YEŞİL ALAN (Ayaktan Acil)',
      location: 'Beşiktaş İskele 112 İstasyonu',
      incidentSummary: 'Bisikletten düşme sonucu sağ ön kolda yüzeyel abrazyon ve hematom.',
      vitals: { bp: '120/75 mmHg', pulse: 78, spo2: 99, gcs: 15, bloodSugar: 95, temp: 36.6 },
      etaMinutes: 0, etrMinutes: 0, status: 'Triaged', encounterId: null, bedAssigned: null,
      createdAt: isoAgo(30), arrivedAt: isoAgo(22)
    }
  ];

  const medulaProvisions = [
    {
      takipNo: '260305108492', encounterId: 1, patientRef: maskTckn('28491028472'),
      sigortaliTuru: '4A (SSK Aktif Çalışan)', bransKodu: '1000', provizyonTipi: 'Normal',
      katilimPayi: 15.00, sonucKodu: '0000', sonucMesaji: 'Müstehaktır. Provizyon onaylandı.',
      createdAt: isoAgo(120)
    },
    {
      takipNo: '260305108494', encounterId: 3, patientRef: maskTckn('48192039481'),
      sigortaliTuru: '4A (SSK Aktif Çalışan)', bransKodu: '4400', provizyonTipi: 'Acil',
      katilimPayi: 0.00, sonucKodu: '0000', sonucMesaji: 'Acil hal kapsamında müstehaktır.',
      createdAt: isoAgo(45)
    }
  ];

  const enabizPackages = [
    {
      id: 1, sysTakipNo: 'SYS-2026-TR-8491', packageType: 'Paket101_HastaKayit',
      patientId: 1, encounterId: 1, status: 'Sent', responseCode: 'SYS_0000',
      responseMessage: 'Hasta kaydı e-Nabız veri tabanında oluşturuldu.', sentAt: isoAgo(120)
    },
    {
      id: 2, sysTakipNo: 'SYS-2026-TR-8494', packageType: 'Paket102_HizmetBildirimi',
      patientId: 10, encounterId: 3, status: 'Sent', responseCode: 'SYS_0000',
      responseMessage: 'Acil hizmet bildirimi onaylandı.', sentAt: isoAgo(30)
    }
  ];

  const lisInbox = [
    {
      id: 1,
      messageControlId: 'MSG-20261105-0912',
      sourceSystem: 'Roche Cobas e411',
      status: 'Processed',
      receivedAt: isoAgo(21),
      processedAt: isoAgo(20),
      lastError: null
    }
  ];

  const integrations = [
    { id: 1, target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket101_HastaKayit', aggregateType: 'patient', aggregateId: 'HB-000101', status: 'Sent', attempts: 1, createdAt: isoAgo(120), nextAttemptAt: isoAgo(120), lastError: null, payload: { sysTakipNo: 'SYS-2026-TR-8491', paketTipi: 101 } },
    { id: 2, target: 'SGK MEDULA Gateway', eventType: 'GSS_ProvizyonSorgu', aggregateType: 'encounter', aggregateId: 'SEED-ENCOUNTER-101', status: 'Sent', attempts: 1, createdAt: isoAgo(118), nextAttemptAt: isoAgo(118), lastError: null, payload: { medulaTakipNo: '260305108492', sonucKodu: '0000' } },
    { id: 3, target: 'SGK MEDULA Gateway', eventType: 'eRecete_Kayit', aggregateType: 'prescription', aggregateId: 'RX-1', status: 'Sent', attempts: 1, createdAt: isoAgo(38), nextAttemptAt: isoAgo(38), lastError: null, payload: { medulaEreceteNo: '26A9BC4' } },
    { id: 4, target: 'MHRS Gateway (Bakanlık)', eventType: 'RandevuSenkronizasyon', aggregateType: 'mhrs', aggregateId: 'MHRS-2026-8001', status: 'Sent', attempts: 1, createdAt: isoAgo(125), nextAttemptAt: isoAgo(125), lastError: null, payload: { randevuNo: 'MHRS-2026-8001' } },
    { id: 5, target: 'ULAK 112 Acil Vaka Ağı', eventType: 'VakaKabulBildirimi', aggregateType: 'emergency', aggregateId: 'ULAK-112-901', status: 'Sent', attempts: 1, createdAt: isoAgo(42), nextAttemptAt: isoAgo(42), lastError: null, payload: { protokolNo: 'ULAK-112-901', yatak: 'KIRMIZI-1' } },
    { id: 6, target: 'LIS / HL7 v2 (Cihaz Ağı)', eventType: 'ORU_R01_SonucAlimi', aggregateType: 'lab_result', aggregateId: 'ORDER-3', status: 'Sent', attempts: 1, createdAt: isoAgo(20), nextAttemptAt: isoAgo(20), lastError: null, payload: { msh10: 'MSG-20261105-0912' } },
    { id: 7, target: 'İTS / ÜTS (Ürün Takip Sistemi)', eventType: 'KarekodTuketimBildirimi', aggregateType: 'its', aggregateId: 'UTS-DRG-05', status: 'Sent', attempts: 1, createdAt: isoAgo(30), nextAttemptAt: isoAgo(30), lastError: null, payload: { urun: 'UTS-DRG-05' } },
    { id: 8, target: 'SGK MEDULA Gateway', eventType: 'Fatura_GSS_Iletim', aggregateType: 'invoice', aggregateId: 'DEMO-INV-2026-002', status: 'Pending', attempts: 0, createdAt: isoAgo(10), nextAttemptAt: isoAgo(10), lastError: null, payload: { faturaNo: 'DEMO-INV-2026-002', tutar: 4250.00 } },
    { id: 9, target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket401_AsiBildirimi', aggregateType: 'vaccine', aggregateId: 'SEED-VAX-001', status: 'Sent', attempts: 1, createdAt: isoAgo(1400), nextAttemptAt: isoAgo(1400), lastError: null, payload: { asiKodu: 'SKRS-A01' } }
  ];

  // Build valid SHA-256 hash chain for seeded audit events
  const auditEvents = [];
  const seedAuditDefs = [
    { occurredAt: isoAgo(130), username: 'doctor', role: 'doctor', action: 'PATIENT_READ', entityType: 'patient', entityId: '1', details: { mrn: 'HB-000101' } },
    { occurredAt: isoAgo(120), username: 'doctor', role: 'doctor', action: 'ENCOUNTER_CREATED', entityType: 'encounter', entityId: '1', details: { encounterType: 'Outpatient' } },
    { occurredAt: isoAgo(118), username: 'integration', role: 'integration', action: 'MEDULA_PROVISION_FETCHED', entityType: 'medula', entityId: '260305108492', details: { sonucKodu: '0000' } },
    { occurredAt: isoAgo(45), username: 'nurse', role: 'nurse', action: 'ULAK_EMERGENCY_TRIAGE_ADMIT', entityType: 'emergency', entityId: 'ULAK-112-901', details: { bed: 'KIRMIZI-1' } },
    { occurredAt: isoAgo(20), username: 'lab', role: 'lab', action: 'CRITICAL_LAB_RESULT_RECORDED', entityType: 'lab_result', entityId: '6', details: { analyte: '10839-9', value: '1.92' } }
  ];

  for (let i = 0; i < seedAuditDefs.length; i++) {
    const def = seedAuditDefs[i];
    const id = i + 1;
    const previousHash = auditEvents.length ? auditEvents[auditEvents.length - 1].eventHash : '0'.repeat(64);
    const canonicalPayload = computeCanonicalAuditPayload({
      previousHash, id, occurredAt: def.occurredAt, username: def.username, role: def.role,
      action: def.action, entityType: def.entityType, entityId: def.entityId, details: def.details
    });
    const eventHash = crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
    auditEvents.push({
      id,
      occurredAt: def.occurredAt,
      username: def.username,
      role: def.role,
      action: def.action,
      entityType: def.entityType,
      entityId: def.entityId,
      detailsJson: JSON.stringify(def.details),
      previousHash,
      eventHash,
      canonicalPayload
    });
  }

  return {
    patients,
    encounters,
    beds,
    admissions,
    bedTransfers,
    drugs,
    stockMovements,
    orders,
    labResults,
    radiologyReports,
    vitals,
    clinicalNotes,
    prescriptions,
    invoices,
    vaccinations,
    mhrsAppointments,
    ulakCases,
    medulaProvisions,
    enabizPackages,
    lisInbox,
    integrations,
    auditEvents,
    idempotencyKeys: new Map(),
    counters: {
      patient: 15,
      encounter: 8,
      admission: 4,
      bedTransfer: 1,
      drug: 15,
      stockMovement: 2,
      order: 10,
      labResult: 8,
      radiologyReport: 4,
      vitals: 3,
      clinicalNote: 2,
      prescription: 3,
      invoice: 4,
      vaccination: 4,
      enabizPackage: 2,
      lisInbox: 1,
      integration: 9,
      audit: seedAuditDefs.length
    }
  };
}

// --- APPLICATION FACTORY (Isolated per server instance) ---

function createApp({ port = 8088 } = {}) {
  let db = createInitialDataset();
  const sessions = new Map();
  const connectorsConfig = createConnectorsConfig(port);

  function appendAudit(actor, action, entityType, entityId, details = {}) {
    const id = ++db.counters.audit;
    const occurredAt = new Date().toISOString();
    const username = typeof actor === 'string' ? actor : (actor?.username || 'system');
    const role = typeof actor === 'string' ? actor : (actor?.role || 'system');
    const previousHash = db.auditEvents.length ? db.auditEvents[db.auditEvents.length - 1].eventHash : '0'.repeat(64);
    const detailsObj = details && typeof details === 'object' ? details : {};
    const canonicalPayload = computeCanonicalAuditPayload({
      previousHash, id, occurredAt, username, role, action, entityType, entityId, details: detailsObj
    });
    const eventHash = crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
    const evt = {
      id,
      occurredAt,
      username,
      role,
      action,
      entityType,
      entityId: entityId === null || entityId === undefined ? null : String(entityId),
      detailsJson: JSON.stringify(detailsObj),
      previousHash,
      eventHash,
      canonicalPayload
    };
    db.auditEvents.push(evt);
    return evt;
  }

  function pushIntegration({ target, eventType, aggregateType, aggregateId, status = 'Sent', payload = {} }) {
    const nowIso = new Date().toISOString();
    const item = {
      id: ++db.counters.integration,
      target,
      eventType,
      aggregateType,
      aggregateId: String(aggregateId),
      status,
      attempts: status === 'Sent' ? 1 : 0,
      createdAt: nowIso,
      nextAttemptAt: nowIso,
      lastError: null,
      payload
    };
    db.integrations.unshift(item);
    return item;
  }

  function stripIntegrationPayload(item) {
    return {
      id: item.id,
      target: item.target,
      eventType: item.eventType,
      aggregateType: item.aggregateType,
      aggregateId: item.aggregateId,
      status: item.status,
      attempts: item.attempts,
      createdAt: item.createdAt,
      nextAttemptAt: item.nextAttemptAt,
      lastError: item.lastError
    };
  }

  // --- 12-STEP HOSPITAL SIMULATION ENGINE ---
  const simulationEngine = {
    isRunning: false,
    isPaused: false,
    currentStep: 0,
    totalSteps: 12,
    history: [],
    locked: false,
    steps: [
      { id: 0, department: 'MHRS & Danışma', title: 'MHRS Randevu Gelişi & Danışma Karşılama', icon: '📅', text: 'Zeynep Çelik poliklinik randevusu için danışmaya başvurdu (MHRS-2026-8003). Randevu onaylandı.', page: 'connectors', role: 'registrar', externalSystem: 'Sağlık Bakanlığı MHRS REST', actionType: 'mhrs_admit', entityId: 'MHRS-2026-8003' },
      { id: 1, department: 'MEDULA & Hasta Kabul', title: 'SGK MEDULA Provizyonu & Başvuru Açılışı', icon: '🛡️', text: 'GSS Müstehaklık onaylandı. MEDULA Takip No: 260305108502 (Katılım Payı: 15.00 ₺). Başvuru açıldı.', page: 'dashboard', role: 'billing', externalSystem: 'SGK MEDULA GSS WSDL', actionType: 'medula_provision', entityId: '260305108502' },
      { id: 2, department: 'Poliklinik Muayenesi', title: 'Hekim Muayenesi & ICD-10 Tanı Girişi', icon: '👨‍⚕️', text: 'Uzm. Dr. Mehmet Kaya hastayı muayene etti. Tanı: E06.3 Hashimoto Tiroiditi ve SOAP notu kaydedildi.', page: 'clinical', role: 'doctor', externalSystem: 'Klinik Karar Destek', actionType: 'examination', entityId: 'E06.3' },
      { id: 3, department: 'Klinik İstemler', title: 'LİS Laboratuvar & PACS Radyoloji İstemleri', icon: '✚', text: 'TSH / sT4 Hormon Paneli (LOINC: 3016-3) ve Tiroid Doppler USG (SUT: 803.100) hekim tarafından istendi.', page: 'clinical', role: 'doctor', externalSystem: 'Klinik İstem Motoru', actionType: 'order_create', entityId: '3016-3' },
      { id: 4, department: 'LİS Laboratuvar', title: 'LİS / HL7 Otoanalizör Cihaz Sonucu Aktarımı', icon: '🔬', text: 'Roche Cobas analizöründen HL7 ORU^R01 protokolü ile TSH: 8.45 uIU/mL (Yüksek) sonucu aktarıldı ve onaylandı.', page: 'clinical', role: 'lab', externalSystem: 'HL7 v2.5.1 / Sysmex & Cobas', actionType: 'lab_result', entityId: 'TSH-3016-3' },
      { id: 5, department: 'PACS Radyoloji', title: 'PACS DICOM Görüntüleme & Radyoloji Raporu', icon: '🩻', text: 'Uzm. Dr. Burak Koç tiroid USG incelemesini tamamladı, DICOM serisini PACS arşivine aktardı ve raporu onayladı.', page: 'clinical', role: 'radiology', externalSystem: 'PACS DICOMweb WADO-RS', actionType: 'dicom_view', entityId: '803.100' },
      { id: 6, department: 'MEDULA e-Reçete', title: 'SGK MEDULA e-Reçete Düzenleme', icon: '💊', text: 'Uzm. Dr. Mehmet Kaya Levotiroksin Sodyum 100 mcg e-Reçetesi yazdı. SGK MEDULA e-Reçete No: 26T89A2 onaylandı.', page: 'pharmacy', role: 'doctor', externalSystem: 'SGK MEDULA e-Reçete', actionType: 'prescription', entityId: '26T89A2' },
      { id: 7, department: 'Eczane & İTS/ÜTS', title: 'TİTCK İTS/ÜTS Karekod Doğrulama & İlaç Karşılama', icon: '⚕', text: 'Eczane Levotiroksin Sodyum 100 mcg reçetesini karşıladı, GS1-128 DataMatrix karekod İTS nezdinde tüketildi ve stok güncellendi.', page: 'pharmacy', role: 'pharmacist', externalSystem: 'TİTCK İTS/ÜTS Tekil Takip', actionType: 'its_verify', entityId: 'UTS-DRG-13' },
      { id: 8, department: 'ULAK 112 Acil', title: 'Sağlık Bakanlığı ULAK 112 Ambulans Vaka Nakli', icon: '🚨', text: '34 AS 1124 plakalı ambulans 112 ASOS ağı üzerinden Kırmızı Alan vakasını (Akut Koroner Sendrom) hastaneye getirdi.', page: 'connectors', role: 'nurse', externalSystem: 'Sağlık Bakanlığı ULAK 112 ASOS', actionType: 'ulak_emergency', entityId: 'ULAK-112-901' },
      { id: 9, department: 'Acil Triyaj & ADT', title: 'Acil Triyaj Masası & Yatak Tahsisi', icon: '▦', text: 'Acil triyajda kırmızı alan hastası resüsitasyon masasına kabul edildi, Dahiliye 102-A yatağı temizlenip kullanıma açıldı.', page: 'beds', role: 'nurse', externalSystem: 'ADT & Servis Yatak Yönetimi', actionType: 'bed_allocation', entityId: 'KIRMIZI-1' },
      { id: 10, department: 'Finans & Fatura', title: 'SGK MEDULA SUT Fatura İnceleme & Tahsilat', icon: '₺', text: 'Poliklinik ve acil hizmetleri SUT Faturası SGK MEDULA servisine iletildi ve 0000 koduyla onaylandı.', page: 'billing', role: 'billing', externalSystem: 'SGK MEDULA Fatura İnceleme', actionType: 'invoice_medula', entityId: 'DEMO-INV-2026-004' },
      { id: 11, department: 'USS e-Nabız & Omurga', title: 'Sağlık Bakanlığı USS e-Nabız Paket Gönderimi', icon: '☁', text: 'Günün tüm muayene, tetkik ve fatura verileri Sağlık Bakanlığı USS Paket 102/401 e-Nabız kuyruğuna aktarıldı. 12 adımlı döngü tamamlandı!', page: 'connectors', role: 'integration', externalSystem: 'Sağlık Bakanlığı USS e-Nabız', actionType: 'uss_package', entityId: 'SYS-2026-TR-8520' }
    ],

    executeStep(stepNum, actor) {
      const idx = ((stepNum !== undefined ? stepNum : this.currentStep) % this.totalSteps + this.totalSteps) % this.totalSteps;
      const stepDef = this.steps[idx];
      const timestamp = new Date().toISOString();

      if (idx === 0) {
        const appt = db.mhrsAppointments.find(a => a.id === 'MHRS-2026-8003');
        if (appt) appt.status = 'Arrived';
        appendAudit(actor || 'registrar', 'MHRS_PATIENT_ARRIVED', 'mhrs', 'MHRS-2026-8003', { step: 0 });
      } else if (idx === 1) {
        const appt = db.mhrsAppointments.find(a => a.id === 'MHRS-2026-8003');
        const nextEncId = ++db.counters.encounter;
        const takipNo = '260305108502';
        const newEnc = {
          id: nextEncId, patientId: 5, encounterType: 'Outpatient', status: 'Open',
          chiefComplaint: 'Hashimoto Tiroiditi Takibi (Simülasyon)', openedAt: timestamp, closedAt: null,
          externalRef: `SIM-ENC-${nextEncId}`, medulaTakipNo: takipNo,
          sysTakipNo: 'SYS-2026-TR-8502', mhrsRandevuId: 'MHRS-2026-8003', ulakProtokolNo: null
        };
        db.encounters.unshift(newEnc);
        if (appt) { appt.status = 'Admitted'; appt.encounterId = nextEncId; appt.medulaTakipNo = takipNo; }
        db.medulaProvisions.unshift({
          takipNo, encounterId: nextEncId, patientRef: maskTckn('58291039482'),
          sigortaliTuru: '4A (SSK Aktif Çalışan)', bransKodu: '1000', provizyonTipi: 'Normal',
          katilimPayi: 15.00, sonucKodu: '0000', sonucMesaji: 'Müstehaktır. Provizyon onaylandı.', createdAt: timestamp
        });
        pushIntegration({
          target: 'SGK MEDULA Gateway', eventType: 'GSS_ProvizyonSorgu',
          aggregateType: 'encounter', aggregateId: String(nextEncId),
          payload: { takipNo, hasta: 'Zeynep Çelik', katilimPayi: 15.00 }
        });
        appendAudit(actor || 'billing', 'MEDULA_PROVISION_FETCHED', 'medula', takipNo, { encounterId: nextEncId });
      } else if (idx === 2) {
        const enc = db.encounters.find(e => e.patientId === 5) || db.encounters[0];
        if (enc) {
          enc.chiefComplaint = 'Hashimoto Tiroiditi Kontrolü. Tanı: E06.3';
          db.clinicalNotes.unshift({
            id: ++db.counters.clinicalNote, encounterId: enc.id, author: 'Uzm. Dr. Mehmet Kaya',
            authorRole: 'doctor', noteType: 'SOAP',
            subjective: 'Yorgunluk ve soğuğa tahammülsüzlük yakınması.',
            objective: 'Tiroid bezi diffüz hafif büyümüş, vital bulgular stabil.',
            assessment: 'E06.3 Otoimmün Tiroidit (Hashimoto)',
            plan: 'TSH/sT4 paneli ve Tiroid Doppler USG istendi.',
            createdAt: timestamp
          });
        }
        appendAudit(actor || 'doctor', 'CLINICAL_EXAMINATION_COMPLETED', 'encounter', enc?.id || 1, { icd10: 'E06.3' });
      } else if (idx === 3) {
        const enc = db.encounters.find(e => e.patientId === 5) || db.encounters[0];
        const ordLabId = ++db.counters.order;
        db.orders.unshift({
          id: ordLabId, encounterId: enc.id, orderType: 'LAB', codeSystem: 'LOINC', code: '3016-3',
          description: 'TSH & Serbest T4 Paneli', orderedBy: 'Doç. Dr. Serdar Tekin',
          status: 'Submitted', priority: 'R', clinicalNote: 'Tiroid fonksiyon değerlendirmesi',
          createdAt: timestamp, updatedAt: timestamp, externalRef: `SIM-ORD-${ordLabId}`,
          icd10: 'E06.3', sutCode: '701.210'
        });
        const ordRadId = ++db.counters.order;
        db.orders.unshift({
          id: ordRadId, encounterId: enc.id, orderType: 'RAD', codeSystem: 'SUT', code: '803.100',
          description: 'Tiroid ve Boyun Renkli Doppler USG', orderedBy: 'Doç. Dr. Serdar Tekin',
          status: 'Submitted', priority: 'R', clinicalNote: 'Parankim heterojenite değerlendirmesi',
          createdAt: timestamp, updatedAt: timestamp, externalRef: `SIM-ORD-${ordRadId}`,
          icd10: 'E06.3', sutCode: '803.100'
        });
        appendAudit(actor || 'doctor', 'ORDERS_CREATED', 'order', ordLabId, { radOrderId: ordRadId });
      } else if (idx === 4) {
        const labOrd = db.orders.find(o => o.code === '3016-3');
        if (labOrd) { labOrd.status = 'Verified'; labOrd.updatedAt = timestamp; }
        const resId = ++db.counters.labResult;
        db.labResults.unshift({
          id: resId, orderId: labOrd?.id || 1, analyteCode: '3016-3',
          display: 'Tirotropin (TSH)', value: '8.45', unit: 'uIU/mL',
          referenceRange: '0.40 - 4.20', flag: 'H', criticalFlag: false,
          criticalAckBy: null, criticalAckAt: null, criticalAckNote: null, communicatedWith: null,
          resultedAt: timestamp
        });
        db.lisInbox.unshift({
          id: ++db.counters.lisInbox,
          messageControlId: `SIM-ORU-${Date.now()}`,
          sourceSystem: 'Roche Cobas e411',
          status: 'Processed',
          receivedAt: timestamp,
          processedAt: timestamp,
          lastError: null
        });
        pushIntegration({
          target: 'LIS / HL7 v2 (Cihaz Ağı)', eventType: 'ORU_R01_SonucAlimi',
          aggregateType: 'lab_result', aggregateId: String(resId),
          payload: { cihaz: 'Roche Cobas e411', analiz: 'TSH 8.45 uIU/mL (Yüksek)', ack: 'AA' }
        });
        appendAudit(actor || 'lab', 'HL7_LAB_RESULT_ACCEPTED', 'lab_result', resId, { orderId: labOrd?.id || 1 });
      } else if (idx === 5) {
        const radOrd = db.orders.find(o => o.code === '803.100');
        if (radOrd) { radOrd.status = 'Verified'; radOrd.updatedAt = timestamp; }
        const repId = ++db.counters.radiologyReport;
        db.radiologyReports.unshift({
          id: repId, orderId: radOrd?.id || 1, code: '803.100',
          description: 'Tiroid Doppler USG', modality: 'US',
          impression: 'Bilateral tiroid bezi parankimi diffüz heterojen, psödonodüler görünüm (Kronik tiroidit).',
          reportText: 'KLİNİK: Hashimoto takibi.\nBULGULAR: Sağ ve sol tiroid lob konturları lobüle, vaskülarite artmıştır. Malignite lehine kalsifiye kitle izlenmedi.',
          reportedBy: 'Uzm. Dr. Burak Koç', reportedAt: timestamp,
          dicomSeriesUid: `1.2.840.10008.5.1.4.1.1.6.${Date.now()}`
        });
        appendAudit(actor || 'radiology', 'RADIOLOGY_REPORT_SIGNED', 'radiology_report', repId, { orderId: radOrd?.id || 1 });
      } else if (idx === 6) {
        const enc = db.encounters.find(e => e.patientId === 5) || db.encounters[0];
        const nextRxId = ++db.counters.prescription;
        db.prescriptions.unshift({
          id: nextRxId, encounterId: enc.id, prescribedBy: 'Doç. Dr. Serdar Tekin',
          status: 'Pending', createdAt: timestamp, dispensedAt: null, dispensedBy: null,
          medulaEreceteNo: '26T89A2', tesisKodu: '11340001',
          overrideAllergy: false, overrideReason: null,
          items: [{
            drugId: 13, dosage: '100 mcg', frequency: 'Günde 1 kez (Sabah Aç)',
            durationDays: 30, quantity: 1, dispensedQty: 0,
            usage: 'Sabah kahvaltıdan 30 dk önce bol su ile', utsBarcode: '8699525010135'
          }]
        });
        pushIntegration({
          target: 'SGK MEDULA Gateway', eventType: 'eRecete_Kayit',
          aggregateType: 'prescription', aggregateId: `RX-${nextRxId}`,
          payload: { medulaEreceteNo: '26T89A2', ilac: 'Levotiroksin Sodyum 100 mcg' }
        });
        appendAudit(actor || 'doctor', 'MEDULA_ERECETE_CREATED', 'prescription', nextRxId, { drugId: 13 });
      } else if (idx === 7) {
        const rx = db.prescriptions.find(p => p.medulaEreceteNo === '26T89A2') || db.prescriptions[0];
        if (rx && rx.status === 'Pending') {
          rx.status = 'Dispensed';
          rx.dispensedAt = timestamp;
          rx.dispensedBy = 'Ecz. Selin Aydın';
          for (const item of rx.items) {
            const drug = db.drugs.find(d => d.id === item.drugId);
            if (drug && drug.stock >= item.quantity) {
              drug.stock -= item.quantity;
              item.dispensedQty = item.quantity;
              db.stockMovements.unshift({
                id: ++db.counters.stockMovement,
                drugId: drug.id,
                prescriptionId: rx.id,
                movementType: 'DISPENSE',
                qtyDelta: -item.quantity,
                referenceNo: `RX-${rx.id}`,
                actor: 'pharmacist',
                createdAt: timestamp
              });
            }
          }
        }
        pushIntegration({
          target: 'İTS / ÜTS (Ürün Takip Sistemi)', eventType: 'KarekodTuketimBildirimi',
          aggregateType: 'its', aggregateId: 'UTS-DRG-13',
          payload: { karekod: '0869952501013521984210', ilac: 'Levotiroksin Sodyum 100 mcg', durum: 'Tekil Tüketim Onaylandı' }
        });
        appendAudit(actor || 'pharmacist', 'ITS_CONSUMPTION_CONFIRMED', 'prescription', rx?.id || 1, { drugId: 13 });
      } else if (idx === 8) {
        const caseItem = db.ulakCases.find(c => c.id === 'ULAK-112-901');
        if (caseItem) { caseItem.status = 'InHospital'; caseItem.bedAssigned = 'KIRMIZI-1'; }
        pushIntegration({
          target: 'ULAK 112 Acil Vaka Ağı', eventType: 'VakaKabulBildirimi',
          aggregateType: 'emergency', aggregateId: 'ULAK-112-901',
          payload: { ambulans: '34 AS 1124', ekip: '34-KRT-112', yatak: 'KIRMIZI-1', triyaj: 'RED' }
        });
        appendAudit(actor || 'nurse', 'ULAK_EMERGENCY_TRIAGE_ADMIT', 'emergency', 'ULAK-112-901', { bed: 'KIRMIZI-1' });
      } else if (idx === 9) {
        const bed = db.beds.find(b => b.bedNo === '102-A');
        if (bed) bed.status = 'Available';
        appendAudit(actor || 'nurse', 'BED_CLEANING_COMPLETED', 'bed', bed?.id || 3, { bedNo: '102-A' });
      } else if (idx === 10) {
        const enc = db.encounters.find(e => e.patientId === 5) || db.encounters[0];
        const nextInvId = ++db.counters.invoice;
        const invoiceNo = `DEMO-INV-2026-${String(nextInvId).padStart(3, '0')}`;
        db.invoices.unshift({
          id: nextInvId, encounterId: enc.id, invoiceNo, payer: 'SGK', status: 'Paid', currency: 'TRY',
          totalAmount: 1250.00, sgkShare: 1235.00, patientShare: 15.00,
          medulaTakipNo: '260305108502', medulaDurum: 'Onaylandı (Kod: 0000)', createdAt: timestamp, paidAt: timestamp,
          lines: [
            { code: '520.010', description: 'Endokrinoloji Uzman Muayenesi', qty: 1, unitPrice: 350.00, lineTotal: 350.00 },
            { code: '701.210', description: 'Tirotropin (TSH) ve sT4 Paneli', qty: 1, unitPrice: 450.00, lineTotal: 450.00 },
            { code: '803.100', description: 'Tiroid Renkli Doppler Ultrasonografi', qty: 1, unitPrice: 450.00, lineTotal: 450.00 }
          ]
        });
        pushIntegration({
          target: 'SGK MEDULA Gateway', eventType: 'Fatura_GSS_Iletim',
          aggregateType: 'invoice', aggregateId: invoiceNo,
          payload: { faturaNo: invoiceNo, tutar: 1250.00, onay: '0000_KABUL' }
        });
        appendAudit(actor || 'billing', 'INVOICE_PAID', 'invoice', nextInvId, { invoiceNo });
      } else if (idx === 11) {
        const enc = db.encounters.find(e => e.patientId === 5) || db.encounters[0];
        const sysTakipNo = 'SYS-2026-TR-8520';
        db.enabizPackages.unshift({
          id: ++db.counters.enabizPackage,
          sysTakipNo, packageType: 'Paket102_HizmetBildirimi',
          patientId: enc.patientId, encounterId: enc.id,
          status: 'Sent', responseCode: 'SYS_0000',
          responseMessage: 'Bakanlık e-Nabız servisi tarafından onaylandı.', sentAt: timestamp
        });
        pushIntegration({
          target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket102_HizmetBildirimi',
          aggregateType: 'encounter', aggregateId: String(enc.id),
          payload: { sysTakipNo, paket: 102, durum: 'Bakanlık Onaylandı' }
        });
        appendAudit(actor || 'integration', 'USS_PACKAGE_TRANSMITTED', 'uss', sysTakipNo, { packageType: 'Paket102_HizmetBildirimi' });
      }

      const eventRecord = {
        step: idx,
        totalSteps: this.totalSteps,
        department: stepDef.department,
        title: stepDef.title,
        icon: stepDef.icon,
        text: stepDef.text,
        page: stepDef.page,
        role: stepDef.role,
        externalSystem: stepDef.externalSystem,
        actionType: stepDef.actionType,
        entityId: stepDef.entityId,
        timestamp
      };

      this.history.unshift(eventRecord);
      if (this.history.length > 50) this.history.pop();
      this.currentStep = (idx + 1) % this.totalSteps;
      return eventRecord;
    }
  };

  function buildSimStatePayload(extra = {}) {
    const nextStepInfo = simulationEngine.steps[simulationEngine.currentStep % simulationEngine.totalSteps];
    const simStatus = simulationEngine.isRunning
      ? (simulationEngine.isPaused ? 'paused' : 'running')
      : 'stopped';
    const stateObj = {
      status: simStatus,
      running: simulationEngine.isRunning,
      paused: simulationEngine.isPaused,
      currentStepIndex: simulationEngine.currentStep,
      totalSteps: simulationEngine.totalSteps,
      currentStep: nextStepInfo,
      locked: simulationEngine.isRunning && !simulationEngine.isPaused,
      history: simulationEngine.history.slice(0, 20)
    };
    return {
      success: true,
      ...stateObj,
      state: stateObj,
      ...extra
    };
  }

  // --- HTTP HELPERS ---

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
    'Cache-Control': 'no-store'
  };

  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Correlation-ID, X-Demo-Session, X-Demo-Role, Idempotency-Key'
    });
    res.end(JSON.stringify(data));
  }

  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) {
          req.destroy();
          reject(new HttpError(413, 'İstek gövdesi izin verilen 5 MB sınırını aşıyor.'));
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  async function parseJsonBody(req) {
    const raw = await readRawBody(req);
    if (!raw || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new HttpError(400, 'Geçersiz JSON gövdesi.');
    }
  }

  function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    return map[ext] || 'application/octet-stream';
  }

  function resolveSession(req) {
    const authHeader = String(req.headers['authorization'] || '');
    let token = null;
    if (/^Bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^Bearer\s+/i, '').trim();
    } else if (req.headers['x-demo-session']) {
      token = String(req.headers['x-demo-session']).trim();
    }

    if (token && sessions.has(token)) {
      const session = sessions.get(token);
      return { token, user: session.user };
    }

    if (process.env.HBYS_ALLOW_ROLE_HEADER === '1') {
      const roleHdr = String(req.headers['x-demo-role'] || '').trim().toLowerCase();
      if (roleHdr && DEMO_USERS[roleHdr]) {
        return { token: null, user: DEMO_USERS[roleHdr] };
      }
    }
    return null;
  }

  function requireRoles(actor, allowedRoles) {
    if (!allowedRoles.includes(actor.role)) {
      throw new HttpError(403, 'Bu işlem için yetkiniz bulunmamaktadır.', {
        code: 'FORBIDDEN',
        requiredRoles: allowedRoles,
        actualRole: actor.role
      });
    }
  }

  function formatFullName(p) {
    if (!p || !p.givenName) return null;
    return `${p.givenName} ${p.familyName || ''}`.trim();
  }

  function enrichEncounter(e) {
    const p = db.patients.find(x => x.id === e.patientId) || {};
    return {
      ...e,
      mrn: p.mrn || null,
      givenName: p.givenName || null,
      familyName: p.familyName || null,
      patientName: formatFullName(p)
    };
  }

  function enrichOrder(o) {
    const enc = db.encounters.find(e => e.id === o.encounterId) || {};
    const pat = db.patients.find(p => p.id === enc.patientId) || {};
    return {
      ...o,
      mrn: pat.mrn || null,
      givenName: pat.givenName || null,
      familyName: pat.familyName || null,
      patientName: formatFullName(pat)
    };
  }

  function enrichLabResult(l) {
    const ord = db.orders.find(o => o.id === l.orderId) || {};
    const enc = db.encounters.find(e => e.id === ord.encounterId) || {};
    const pat = db.patients.find(p => p.id === enc.patientId) || {};
    return {
      ...l,
      orderCode: ord.code || null,
      encounterId: ord.encounterId || null,
      mrn: pat.mrn || null,
      givenName: pat.givenName || null,
      familyName: pat.familyName || null,
      patientName: formatFullName(pat)
    };
  }

  function enrichRadiologyReport(r) {
    const ord = db.orders.find(o => o.id === r.orderId) || {};
    const enc = db.encounters.find(e => e.id === ord.encounterId) || {};
    const pat = db.patients.find(p => p.id === enc.patientId) || {};
    return {
      ...r,
      encounterId: ord.encounterId || null,
      mrn: pat.mrn || null,
      givenName: pat.givenName || null,
      familyName: pat.familyName || null,
      patientName: formatFullName(pat)
    };
  }

  function enrichPrescription(rx) {
    const enc = db.encounters.find(e => e.id === rx.encounterId) || {};
    const pat = db.patients.find(p => p.id === enc.patientId) || {};
    const items = (rx.items || []).map(it => {
      const drug = db.drugs.find(d => d.id === it.drugId) || {};
      return {
        ...it,
        drugName: drug.name || `İlaç #${it.drugId}`,
        genericName: drug.genericName || null,
        utsBarcode: it.utsBarcode || drug.barcode || null
      };
    });
    return {
      ...rx,
      allergyOverridden: Boolean(rx.overrideAllergy),
      items,
      itemCount: items.length,
      mrn: pat.mrn || null,
      givenName: pat.givenName || null,
      familyName: pat.familyName || null,
      patientName: formatFullName(pat)
    };
  }

  function buildChargePreview(encounterId) {
    const enc = db.encounters.find(e => e.id === encounterId);
    if (!enc) throw new HttpError(404, 'Başvuru bulunamadı.');
    const lines = [];
    if (enc.encounterType === 'Emergency') {
      lines.push({ code: '520.030', description: 'Acil Servis Muayene ve İlk Müdahale (SUT)', qty: 1, unitPrice: 650.00, lineTotal: 650.00 });
    } else if (enc.encounterType === 'Inpatient') {
      lines.push({ code: '510.010', description: 'Yatan Hasta Günlük Servis Bakımı (SUT)', qty: 1, unitPrice: 950.00, lineTotal: 950.00 });
    } else {
      lines.push({ code: '520.010', description: 'Uzman Tabip Poliklinik Muayenesi (SUT)', qty: 1, unitPrice: 350.00, lineTotal: 350.00 });
    }

    const encOrders = db.orders.filter(o => o.encounterId === encounterId && o.status !== 'Cancelled' && o.status !== 'Rejected');
    for (const o of encOrders) {
      const unitPrice = o.orderType === 'RAD' ? 680.00 : o.orderType === 'PROCEDURE' ? 400.00 : o.orderType === 'CONSULT' ? 300.00 : 250.00;
      lines.push({
        code: o.sutCode || o.code,
        description: o.description,
        qty: 1,
        unitPrice,
        lineTotal: unitPrice
      });
    }

    const totalAmount = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
    const patientShare = enc.encounterType === 'Emergency' ? 0 : 15.00;
    const sgkShare = roundMoney(Math.max(0, totalAmount - patientShare));

    return {
      encounterId: enc.id,
      payer: 'SGK',
      medulaTakipNo: enc.medulaTakipNo || null,
      lines,
      totalAmount,
      sgkShare,
      patientShare,
      currency: 'TRY'
    };
  }

  // --- MAIN REQUEST HANDLER ---
  async function handleRequest(req, res) {
    const rawUrlPath = String(req.url || '/').split('?')[0];
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...SECURITY_HEADERS,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Correlation-ID, X-Demo-Session, X-Demo-Role, Idempotency-Key'
      });
      res.end();
      return;
    }

    try {
      // 1. Public Health & Config & Auth Discovery
      if (method === 'GET' && (pathname === '/health' || pathname.startsWith('/health/') || pathname === '/api/health')) {
        return sendJson(res, 200, { status: 'ok', service: 'nova-hbys-gateway', mode: 'demo' });
      }

      if (method === 'GET' && pathname === '/api/config') {
        const simEnabled = process.env.HBYS_ENABLE_SIMULATION !== 'false';
        return sendJson(res, 200, {
          mode: 'demo',
          auth: 'demo',
          oidc: null,
          features: {
            connectors: true,
            simulation: simEnabled,
            patient360: true,
            cdsAllergy: true,
            criticalAck: true,
            vitalsNews2: true,
            dicomViewer: true,
            hl7Sandbox: true
          }
        });
      }

      if (method === 'GET' && pathname === '/api/auth/roles') {
        return sendJson(res, 200, ALL_ROLES.map(r => ({
          role: r,
          label: ROLE_LABELS[r],
          username: DEMO_USERS[r].username,
          displayName: DEMO_USERS[r].displayName,
          specialty: DEMO_USERS[r].specialty
        })));
      }

      if (method === 'POST' && pathname === '/api/auth/demo-login') {
        const body = await parseJsonBody(req);
        const requested = String(body.role || body.username || '').trim().toLowerCase();
        const resolvedRole = USERNAME_TO_ROLE[requested];
        if (!resolvedRole || !DEMO_USERS[resolvedRole]) {
          return sendJson(res, 400, { error: 'Geçersiz demo rolü veya kullanıcı adı.' });
        }
        const token = crypto.randomUUID();
        const user = { ...DEMO_USERS[resolvedRole] };
        sessions.set(token, { token, user, createdAt: Date.now() });
        appendAudit(user, 'DEMO_LOGIN', 'session', token.slice(0, 8), { role: user.role });
        return sendJson(res, 200, {
          token,
          user,
          roleLabel: ROLE_LABELS[user.role]
        });
      }

      // 2. Enforce authentication on ALL other /api/* endpoints
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const auth = resolveSession(req);
        if (!auth) {
          return sendJson(res, 401, { error: 'Kimlik doğrulaması gerekli.', code: 'UNAUTHORIZED' });
        }
        const actor = auth.user;

        // Auth session management
        if (pathname === '/api/me' && method === 'GET') {
          return sendJson(res, 200, {
            user: actor,
            roleLabel: ROLE_LABELS[actor.role] || actor.role
          });
        }

        if ((pathname === '/api/auth/switch-role' || pathname === '/api/demo/set-role') && method === 'POST') {
          const body = await parseJsonBody(req);
          const requested = String(body.role || '').trim().toLowerCase();
          const resolvedRole = USERNAME_TO_ROLE[requested];
          if (!resolvedRole || !DEMO_USERS[resolvedRole]) {
            return sendJson(res, 400, { error: 'Geçersiz demo rolü.' });
          }
          const nextUser = { ...DEMO_USERS[resolvedRole] };
          const newToken = crypto.randomUUID();
          sessions.set(newToken, { token: newToken, user: nextUser, createdAt: Date.now() });
          if (auth.token && sessions.has(auth.token)) {
            sessions.get(auth.token).user = nextUser;
          }
          appendAudit(actor, 'ROLE_SWITCHED', 'session', newToken.slice(0, 8), { fromRole: actor.role, toRole: nextUser.role });
          return sendJson(res, 200, {
            token: newToken,
            user: nextUser,
            roleLabel: ROLE_LABELS[nextUser.role]
          });
        }

        if (pathname === '/api/auth/logout' && method === 'POST') {
          if (auth.token) sessions.delete(auth.token);
          appendAudit(actor, 'DEMO_LOGOUT', 'session', auth.token ? auth.token.slice(0, 8) : 'header');
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/demo/reset' && method === 'POST') {
          db = createInitialDataset();
          simulationEngine.isRunning = false;
          simulationEngine.isPaused = false;
          simulationEngine.currentStep = 0;
          simulationEngine.history = [];
          simulationEngine.locked = false;
          appendAudit(actor, 'DEMO_DATA_RESET', 'system', 'all');
          return sendJson(res, 200, { success: true, message: 'Tüm test ve simülasyon verileri başarıyla sıfırlandı.' });
        }

        // Simulation Engine Endpoints
        if (pathname === '/api/simulation/state' && method === 'GET') {
          return sendJson(res, 200, buildSimStatePayload());
        }
        if (pathname === '/api/simulation/start' && method === 'POST') {
          simulationEngine.isRunning = true;
          simulationEngine.isPaused = false;
          simulationEngine.locked = true;
          appendAudit(actor, 'FULL_HOSPITAL_SIMULATION_STARTED', 'simulation', 'all');
          return sendJson(res, 200, buildSimStatePayload({ message: 'Canlı Hastane Simülasyonu başlatıldı.' }));
        }
        if (pathname === '/api/simulation/pause' && method === 'POST') {
          simulationEngine.isPaused = true;
          simulationEngine.locked = false;
          appendAudit(actor, 'SIMULATION_PAUSED_FOR_INTERVENTION', 'simulation', String(simulationEngine.currentStep));
          return sendJson(res, 200, buildSimStatePayload({ message: 'Simülasyon duraklatıldı. Manuel müdahaleye izin verildi.' }));
        }
        if (pathname === '/api/simulation/stop' && method === 'POST') {
          simulationEngine.isRunning = false;
          simulationEngine.isPaused = false;
          simulationEngine.locked = false;
          appendAudit(actor, 'SIMULATION_STOPPED', 'simulation', 'all');
          return sendJson(res, 200, buildSimStatePayload({ message: 'Simülasyon iptal edildi ve durduruldu.' }));
        }
        if (pathname === '/api/simulation/step' && method === 'POST') {
          const body = await parseJsonBody(req);
          const stepIdx = body.step !== undefined ? Number(body.step) : simulationEngine.currentStep;
          const eventRecord = simulationEngine.executeStep(stepIdx, actor);
          return sendJson(res, 200, buildSimStatePayload({
            executedStep: eventRecord,
            event: eventRecord,
            step: eventRecord,
            lastEvent: eventRecord
          }));
        }

        // Dashboard
        if (pathname === '/api/dashboard' && method === 'GET') {
          const openEncounters = db.encounters.filter(e => ['Open', 'Admitted'].includes(e.status));
          const occupiedBeds = db.beds.filter(b => b.status === 'Occupied');
          const availableBeds = db.beds.filter(b => b.status === 'Available');
          const pendingRx = db.prescriptions.filter(p => p.status === 'Pending');
          const pendingInt = db.integrations.filter(i => ['Pending', 'Failed'].includes(i.status));
          const criticalLabs = db.labResults.filter(l => l.criticalFlag);
          const activeUlakCases = db.ulakCases.filter(u => ['EnRoute', 'InHospital'].includes(u.status));
          const canSeeRecent = ['admin', 'doctor', 'nurse', 'registrar'].includes(actor.role);
          const recentEncounters = canSeeRecent
            ? db.encounters.slice(0, 6).map(enrichEncounter)
            : [];

          return sendJson(res, 200, {
            patients: db.patients.length,
            openEncounters: openEncounters.length,
            ordersToday: db.orders.length,
            criticalResults: criticalLabs.length,
            occupiedBeds: occupiedBeds.length,
            availableBeds: availableBeds.length,
            pendingPrescriptions: pendingRx.length,
            pendingIntegrations: pendingInt.length,
            activeUlakCases: activeUlakCases.length,
            todayMhrsAppointments: db.mhrsAppointments.length,
            recentEncounters
          });
        }

        // Global Role-Filtered Search (Ctrl+K)
        if (pathname === '/api/search' && method === 'GET') {
          const q = (parsedUrl.searchParams.get('q') || '').trim();
          const ql = q.toLocaleLowerCase('tr');
          const items = [];

          if (ql.length > 0) {
            if (['admin', 'doctor', 'nurse', 'registrar'].includes(actor.role)) {
              for (const p of db.patients) {
                if (`${p.mrn} ${p.givenName} ${p.familyName} ${p.tckn || ''}`.toLocaleLowerCase('tr').includes(ql)) {
                  items.push({
                    type: 'patient', id: p.id, title: `${p.givenName} ${p.familyName}`,
                    subtitle: `${p.mrn} · ${p.chronic || 'Kronik yok'}`, page: 'patients', patientId: p.id, encounterId: null
                  });
                }
              }
              for (const b of db.beds) {
                if (`${b.bedNo} ${b.ward} ${b.room}`.toLocaleLowerCase('tr').includes(ql)) {
                  items.push({
                    type: 'bed', id: b.id, title: `Yatak ${b.bedNo} (${b.ward})`,
                    subtitle: `Oda ${b.room} · ${b.status}`, page: 'beds', patientId: null, encounterId: b.currentEncounterId
                  });
                }
              }
            }
            if (['admin', 'doctor', 'nurse', 'billing', 'registrar'].includes(actor.role)) {
              for (const e of db.encounters) {
                const enriched = enrichEncounter(e);
                if (`#${e.id} ${e.chiefComplaint || ''} ${e.medulaTakipNo || ''} ${enriched.mrn || ''} ${enriched.givenName || ''} ${enriched.familyName || ''}`.toLocaleLowerCase('tr').includes(ql)) {
                  items.push({
                    type: 'encounter', id: e.id, title: `Başvuru #${e.id} · ${enriched.givenName || ''} ${enriched.familyName || ''}`.trim(),
                    subtitle: `${e.encounterType} · ${e.status}`, page: 'patients', patientId: e.patientId, encounterId: e.id
                  });
                }
              }
            }
            if (['admin', 'doctor', 'lab', 'radiology'].includes(actor.role)) {
              for (const o of db.orders) {
                if (actor.role === 'lab' && o.orderType !== 'LAB') continue;
                if (actor.role === 'radiology' && o.orderType !== 'RAD') continue;
                if (`${o.code} ${o.description} ${o.orderType}`.toLocaleLowerCase('tr').includes(ql)) {
                  items.push({
                    type: 'order', id: o.id, title: `${o.description} [${o.orderType}]`,
                    subtitle: `${o.codeSystem}: ${o.code} · ${o.status}`, page: 'clinical', patientId: null, encounterId: o.encounterId
                  });
                }
              }
            }
            if (['admin', 'doctor', 'nurse', 'pharmacist'].includes(actor.role)) {
              for (const d of db.drugs) {
                if (`${d.name} ${d.genericName || ''} ${d.code} ${d.barcode}`.toLocaleLowerCase('tr').includes(ql)) {
                  items.push({
                    type: 'drug', id: d.id, title: d.name,
                    subtitle: `Stok: ${d.stock} · ATC: ${d.atc}`, page: 'pharmacy', patientId: null, encounterId: null
                  });
                }
              }
            }
          }

          return sendJson(res, 200, { query: q, items: items.slice(0, 30) });
        }

        // Patients & Patient 360° Chart
        if (pathname === '/api/patients' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const q = (parsedUrl.searchParams.get('q') || '').trim().toLocaleLowerCase('tr');
          const list = db.patients.filter(p => !q || `${p.mrn} ${p.givenName} ${p.familyName} ${p.tckn || ''}`.toLocaleLowerCase('tr').includes(q));
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/patients' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'registrar']);
          const body = await parseJsonBody(req);
          const givenName = String(body.givenName ?? body.given_name ?? '').trim();
          const familyName = String(body.familyName ?? body.family_name ?? '').trim();
          const birthDate = String(body.birthDate ?? body.birth_date ?? '').trim();
          if (!givenName || !familyName || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
            return sendJson(res, 400, { error: 'Ad, soyad ve YYYY-AA-GG biçiminde doğum tarihi zorunludur.' });
          }
          const sex = String(body.sex || 'U').trim().toUpperCase();
          if (!['F', 'M', 'U'].includes(sex)) {
            return sendJson(res, 400, { error: 'Cinsiyet F, M veya U olmalıdır.' });
          }
          const nextId = ++db.counters.patient;
          const mrn = `HB-${String(nextId + 100).padStart(6, '0')}`;
          const newPatient = {
            id: nextId,
            mrn,
            givenName,
            familyName,
            birthDate,
            sex,
            phone: body.phone ? String(body.phone).trim() : null,
            bloodType: (body.bloodType ?? body.blood_type) ? String(body.bloodType ?? body.blood_type).trim() : null,
            tckn: body.tckn ? String(body.tckn).trim() : String(Math.floor(10000000000 + Math.random() * 89999999999)),
            chronic: body.chronic ? String(body.chronic).trim() : 'Yok',
            allergies: (body.allergies ?? body.allergy) ? String(body.allergies ?? body.allergy).trim() : 'Yok',
            active: true,
            createdAt: new Date().toISOString()
          };
          db.patients.unshift(newPatient);
          const sysTakipNo = `SYS-2026-TR-${Math.floor(1000 + Math.random() * 9000)}`;
          pushIntegration({
            target: 'USS / e-Nabız (Sağlık Bakanlığı)',
            eventType: 'Paket101_HastaKayit',
            aggregateType: 'patient',
            aggregateId: mrn,
            payload: { sysTakipNo, mrn, paket: 101 }
          });
          appendAudit(actor, 'PATIENT_CREATED', 'patient', newPatient.id, { mrn });
          return sendJson(res, 201, newPatient);
        }

        const patientChartMatch = pathname.match(/^\/api\/patients\/(\d+)\/chart$/);
        if (patientChartMatch && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const patientId = Number(patientChartMatch[1]);
          const patient = db.patients.find(p => p.id === patientId);
          if (!patient) return sendJson(res, 404, { error: 'Hasta bulunamadı.' });

          const encounters = db.encounters.filter(e => e.patientId === patientId).map(enrichEncounter);
          const encIds = new Set(encounters.map(e => e.id));
          const vitals = db.vitals.filter(v => encIds.has(v.encounterId));
          const clinicalNotes = db.clinicalNotes.filter(n => encIds.has(n.encounterId));
          const orders = db.orders.filter(o => encIds.has(o.encounterId)).map(enrichOrder);
          const ordIds = new Set(orders.map(o => o.id));
          const labResults = db.labResults.filter(l => ordIds.has(l.orderId)).map(enrichLabResult);
          const radiologyReports = db.radiologyReports.filter(r => ordIds.has(r.orderId)).map(enrichRadiologyReport);
          const prescriptions = db.prescriptions.filter(rx => encIds.has(rx.encounterId)).map(enrichPrescription);
          const vaccinations = db.vaccinations.filter(v => v.patientId === patientId);
          const activeAdmRaw = db.admissions.find(a => encIds.has(a.encounterId) && a.status === 'Admitted') || null;
          let activeAdmission = null;
          if (activeAdmRaw) {
            const bed = db.beds.find(b => b.id === activeAdmRaw.bedId) || {};
            activeAdmission = { ...activeAdmRaw, ward: bed.ward || null, room: bed.room || null, bedNo: bed.bedNo || null };
          }

          return sendJson(res, 200, {
            patient,
            allergies: parseAllergyTokens(patient.allergies),
            encounters,
            vitals,
            clinicalNotes,
            orders,
            labResults,
            radiologyReports,
            prescriptions,
            vaccinations,
            activeAdmission
          });
        }

        // Encounters, Vitals & Clinical Notes
        if (pathname === '/api/encounters' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'billing', 'registrar']);
          const patientIdFilter = parsedUrl.searchParams.get('patientId') ?? parsedUrl.searchParams.get('patient_id');
          const list = db.encounters
            .filter(e => !patientIdFilter || e.patientId === Number(patientIdFilter))
            .map(enrichEncounter)
            .sort((a, b) => b.id - a.id);
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/encounters' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const body = await parseJsonBody(req);
          const patientId = Number(body.patientId ?? body.patient_id);
          const patient = db.patients.find(p => p.id === patientId && p.active);
          if (!patient) return sendJson(res, 404, { error: 'Hasta bulunamadı.' });
          const encounterType = String(body.encounterType ?? body.encounter_type ?? 'Outpatient');
          if (!['Outpatient', 'Emergency', 'Inpatient'].includes(encounterType)) {
            return sendJson(res, 400, { error: 'Geçersiz başvuru türü.' });
          }

          const nextId = ++db.counters.encounter;
          const medulaTakipNo = `2603${String(Math.floor(10000000 + Math.random() * 90000000))}`;
          const sysTakipNo = `SYS-2026-TR-${Math.floor(1000 + Math.random() * 9000)}`;
          const newEncounter = {
            id: nextId,
            patientId,
            encounterType,
            status: 'Open',
            chiefComplaint: String(body.chiefComplaint ?? body.chief_complaint ?? 'Muayene ve değerlendirme').trim(),
            openedAt: new Date().toISOString(),
            closedAt: null,
            externalRef: `ENC-DEMO-${nextId}`,
            medulaTakipNo,
            sysTakipNo,
            mhrsRandevuId: body.mhrsRandevuId ?? body.mhrs_randevu_id ?? null,
            ulakProtokolNo: body.ulakProtokolNo ?? body.ulak_protokol_no ?? null
          };
          db.encounters.unshift(newEncounter);

          pushIntegration({
            target: 'SGK MEDULA Gateway', eventType: 'GSS_ProvizyonSorgu',
            aggregateType: 'encounter', aggregateId: String(newEncounter.id),
            payload: { medulaTakipNo, status: 'Onaylandı (Kod: 0000)' }
          });
          appendAudit(actor, 'ENCOUNTER_CREATED', 'encounter', newEncounter.id, { medulaTakipNo });
          return sendJson(res, 201, enrichEncounter(newEncounter));
        }

        const vitalsMatch = pathname.match(/^\/api\/encounters\/(\d+)\/vitals$/);
        if (vitalsMatch) {
          requireRoles(actor, ['admin', 'doctor', 'nurse']);
          const encounterId = Number(vitalsMatch[1]);
          const enc = db.encounters.find(e => e.id === encounterId);
          if (!enc) return sendJson(res, 404, { error: 'Başvuru bulunamadı.' });

          if (method === 'GET') {
            return sendJson(res, 200, db.vitals.filter(v => v.encounterId === encounterId));
          }
          if (method === 'POST') {
            const body = await parseJsonBody(req);
            const computed = computeNews2({
              systolicBp: body.systolicBp ?? body.systolic_bp,
              diastolicBp: body.diastolicBp ?? body.diastolic_bp,
              heartRate: body.heartRate ?? body.heart_rate,
              respRate: body.respRate ?? body.resp_rate,
              tempC: body.tempC ?? body.temp_c,
              spo2: body.spo2,
              consciousness: body.consciousness
            });
            const record = {
              id: ++db.counters.vitals,
              encounterId,
              ...computed,
              recordedBy: actor.displayName,
              recordedAt: new Date().toISOString()
            };
            db.vitals.unshift(record);
            appendAudit(actor, 'VITALS_RECORDED', 'encounter', encounterId, { news2Score: record.news2Score, news2Risk: record.news2Risk });
            return sendJson(res, 201, record);
          }
        }

        const notesMatch = pathname.match(/^\/api\/encounters\/(\d+)\/notes$/);
        if (notesMatch) {
          requireRoles(actor, ['admin', 'doctor', 'nurse']);
          const encounterId = Number(notesMatch[1]);
          const enc = db.encounters.find(e => e.id === encounterId);
          if (!enc) return sendJson(res, 404, { error: 'Başvuru bulunamadı.' });

          if (method === 'GET') {
            return sendJson(res, 200, db.clinicalNotes.filter(n => n.encounterId === encounterId));
          }
          if (method === 'POST') {
            const body = await parseJsonBody(req);
            const noteType = String(body.noteType ?? body.note_type ?? 'SOAP').trim() || 'SOAP';
            const subjective = String(body.subjective || '').trim();
            const objective = String(body.objective || '').trim();
            const assessment = String(body.assessment || '').trim();
            const plan = String(body.plan || '').trim();
            if (!subjective && !objective && !assessment && !plan) {
              return sendJson(res, 400, { error: 'En az bir SOAP not alanı doldurulmalıdır.' });
            }
            const note = {
              id: ++db.counters.clinicalNote,
              encounterId,
              author: actor.displayName,
              authorRole: actor.role,
              noteType,
              subjective,
              objective,
              assessment,
              plan,
              createdAt: new Date().toISOString()
            };
            db.clinicalNotes.unshift(note);
            appendAudit(actor, 'CLINICAL_NOTE_CREATED', 'encounter', encounterId, { noteId: note.id, noteType });
            return sendJson(res, 201, note);
          }
        }

        const chargePreviewMatch = pathname.match(/^\/api\/encounters\/(\d+)\/charge-preview$/);
        if (chargePreviewMatch && method === 'GET') {
          requireRoles(actor, ['admin', 'billing', 'registrar']);
          const encounterId = Number(chargePreviewMatch[1]);
          return sendJson(res, 200, buildChargePreview(encounterId));
        }

        // Clinical Orders
        if (pathname === '/api/orders' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'lab', 'radiology']);
          const encounterFilter = parsedUrl.searchParams.get('encounterId') ?? parsedUrl.searchParams.get('encounter_id');
          const list = db.orders
            .filter(o => {
              if (encounterFilter && o.encounterId !== Number(encounterFilter)) return false;
              if (actor.role === 'lab') return o.orderType === 'LAB';
              if (actor.role === 'radiology') return o.orderType === 'RAD';
              return true;
            })
            .map(enrichOrder)
            .sort((a, b) => b.id - a.id);
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/orders' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor']);
          const body = await parseJsonBody(req);
          const encounterId = Number(body.encounterId ?? body.encounter_id);
          const enc = db.encounters.find(e => e.id === encounterId && ['Open', 'Admitted'].includes(e.status));
          if (!enc) return sendJson(res, 404, { error: 'Aktif klinik başvuru bulunamadı.' });
          const orderType = String(body.orderType ?? body.order_type ?? 'LAB').trim().toUpperCase();
          if (!ALLOWED_ORDER_TYPES.has(orderType)) {
            return sendJson(res, 400, { error: 'Geçersiz istem türü.' });
          }
          const priority = String(body.priority || 'R').trim().toUpperCase();
          if (!['R', 'U', 'S'].includes(priority)) {
            return sendJson(res, 400, { error: 'Öncelik R, U veya S olmalıdır.' });
          }
          const description = String(body.description || '').trim();
          const code = String(body.code || body.sutCode || body.sut_code || 'TEST-01').trim();
          if (!description) return sendJson(res, 400, { error: 'İstem açıklaması zorunludur.' });

          const nextId = ++db.counters.order;
          const nowIso = new Date().toISOString();
          const newOrder = {
            id: nextId,
            encounterId,
            orderType,
            codeSystem: String(body.codeSystem ?? body.code_system ?? (orderType === 'LAB' ? 'LOINC' : 'SUT')).trim(),
            code,
            description,
            orderedBy: actor.displayName,
            status: body.status === 'Submitted' ? 'Submitted' : 'Created',
            priority,
            clinicalNote: (body.clinicalNote ?? body.clinical_note) ? String(body.clinicalNote ?? body.clinical_note).trim() : null,
            icd10: body.icd10 ? String(body.icd10).trim() : 'R69',
            sutCode: String(body.sutCode ?? body.sut_code ?? code).trim(),
            createdAt: nowIso,
            updatedAt: nowIso,
            externalRef: `ORD-DEMO-${nextId}`
          };
          db.orders.unshift(newOrder);
          appendAudit(actor, 'ORDER_CREATED', 'order', newOrder.id, { orderType, code, description });
          return sendJson(res, 201, enrichOrder(newOrder));
        }

        const orderStatusMatch = pathname.match(/^\/api\/orders\/(\d+)\/status$/);
        if (orderStatusMatch && method === 'PATCH') {
          requireRoles(actor, ['admin', 'doctor', 'lab', 'radiology']);
          const id = Number(orderStatusMatch[1]);
          const order = db.orders.find(o => o.id === id);
          if (!order) return sendJson(res, 404, { error: 'İstem bulunamadı.' });
          const body = await parseJsonBody(req);
          const targetStatus = String(body.status || '').trim();
          const check = checkOrderTransition(order.status, targetStatus, actor.role, order.orderType);
          if (!check.ok) {
            return sendJson(res, check.statusCode, { error: check.error });
          }
          const prevStatus = order.status;
          order.status = targetStatus;
          order.updatedAt = new Date().toISOString();
          appendAudit(actor, 'ORDER_STATUS_CHANGED', 'order', id, { from: prevStatus, to: targetStatus });
          return sendJson(res, 200, enrichOrder(order));
        }

        // Lab Results & Critical Read-Back
        if (pathname === '/api/lab-results' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'lab']);
          const list = db.labResults.map(enrichLabResult).sort((a, b) => b.id - a.id);
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/lab-results' && method === 'POST') {
          requireRoles(actor, ['admin', 'lab']);
          const body = await parseJsonBody(req);
          const orderId = Number(body.orderId ?? body.order_id);
          const ord = db.orders.find(o => o.id === orderId);
          if (!ord) return sendJson(res, 404, { error: 'İstem bulunamadı.' });
          if (ord.orderType !== 'LAB') return sendJson(res, 409, { error: 'Yalnızca laboratuvar istemine sonuç eklenebilir.' });
          if (ord.status !== 'InProgress') return sendJson(res, 409, { error: 'Sonuç yalnızca işlemdeki (InProgress) isteme eklenebilir.' });

          const display = String(body.display || '').trim();
          const value = String(body.value ?? '').trim();
          const analyteCode = String(body.analyteCode ?? body.analyte_code ?? 'LOINC').trim();
          const flag = String(body.flag || 'N').trim().toUpperCase();
          if (!display || !value) return sendJson(res, 400, { error: 'Analit adı ve değer zorunludur.' });
          if (!['N', 'H', 'L', 'HH', 'LL'].includes(flag)) return sendJson(res, 400, { error: 'Geçersiz sonuç bayrağı.' });

          const criticalFlag = evaluateCriticalLab({ analyteCode, display, value, flag, critical: body.criticalFlag ?? body.critical });
          const newResult = {
            id: ++db.counters.labResult,
            orderId,
            analyteCode,
            display,
            value,
            unit: String(body.unit || ''),
            referenceRange: String(body.referenceRange ?? body.reference_range ?? ''),
            flag,
            criticalFlag,
            criticalAckBy: null,
            criticalAckAt: null,
            criticalAckNote: null,
            communicatedWith: null,
            resultedAt: new Date().toISOString()
          };
          db.labResults.unshift(newResult);
          ord.status = 'Resulted';
          ord.updatedAt = newResult.resultedAt;

          pushIntegration({
            target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket201_LaboratuvarSonuc',
            aggregateType: 'lab_result', aggregateId: String(newResult.id),
            payload: { orderId, display, value, criticalFlag }
          });
          appendAudit(actor, 'LAB_RESULT_RECORDED', 'lab_result', newResult.id, { display, value, criticalFlag });
          return sendJson(res, 201, enrichLabResult(newResult));
        }

        const labAckMatch = pathname.match(/^\/api\/lab-results\/(\d+)\/acknowledge$/);
        if (labAckMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor']);
          const id = Number(labAckMatch[1]);
          const result = db.labResults.find(r => r.id === id);
          if (!result) return sendJson(res, 404, { error: 'Laboratuvar sonucu bulunamadı.' });
          if (!result.criticalFlag) return sendJson(res, 409, { error: 'Yalnızca kritik laboratuvar sonuçları için okuma onayı gerekir.' });

          const body = await parseJsonBody(req);
          const communicatedWith = String(body.communicatedWith ?? body.communicated_with ?? 'Laboratuvar Nöbetçi Uzmanı').trim();
          const ackNote = String(body.ackNote ?? body.ack_note ?? '').trim();
          if (!ackNote) return sendJson(res, 400, { error: 'Kritik değer okuma notu (ackNote) zorunludur.' });

          result.criticalAckBy = actor.displayName;
          result.criticalAckAt = new Date().toISOString();
          result.criticalAckNote = ackNote;
          result.communicatedWith = communicatedWith;

          appendAudit(actor, 'CRITICAL_LAB_ACKNOWLEDGED', 'lab_result', id, { communicatedWith, ackNote });
          return sendJson(res, 200, enrichLabResult(result));
        }

        // Radiology Reports
        if (pathname === '/api/radiology-reports' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'lab', 'radiology']);
          const list = db.radiologyReports.map(enrichRadiologyReport).sort((a, b) => b.id - a.id);
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/radiology-reports' && method === 'POST') {
          requireRoles(actor, ['admin', 'radiology']);
          const body = await parseJsonBody(req);
          const orderId = Number(body.orderId ?? body.order_id);
          const ord = db.orders.find(o => o.id === orderId);
          if (!ord) return sendJson(res, 404, { error: 'Radyoloji istemi bulunamadı.' });
          if (ord.orderType !== 'RAD') return sendJson(res, 409, { error: 'Yalnızca radyoloji istemine rapor eklenebilir.' });
          if (ord.status !== 'InProgress') return sendJson(res, 409, { error: 'Rapor yalnızca işlemdeki (InProgress) radyoloji istemine eklenebilir.' });

          const reportText = String(body.reportText ?? body.report_text ?? '').trim();
          const impression = String(body.impression ?? '').trim();
          if (reportText.length < 10 || impression.length < 3) {
            return sendJson(res, 400, { error: 'Rapor metni (min 10 karakter) ve izlenim (min 3 karakter) zorunludur.' });
          }
          const inferredModality = /BT|CT/i.test(ord.description) ? 'CT' : /MR/i.test(ord.description) ? 'MR' : /USG|US/i.test(ord.description) ? 'US' : 'CR';
          const modality = ['CR', 'CT', 'MR', 'US'].includes(String(body.modality || '').toUpperCase())
            ? String(body.modality).toUpperCase()
            : inferredModality;

          const newReport = {
            id: ++db.counters.radiologyReport,
            orderId,
            code: ord.code,
            description: ord.description,
            modality,
            impression,
            reportText,
            reportedBy: actor.displayName,
            reportedAt: new Date().toISOString(),
            dicomSeriesUid: `1.2.840.10008.5.1.4.1.1.1.${Date.now()}`
          };
          db.radiologyReports.unshift(newReport);
          ord.status = 'Resulted';
          ord.updatedAt = newReport.reportedAt;

          pushIntegration({
            target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket204_RadyolojiRaporu',
            aggregateType: 'radiology_report', aggregateId: String(newReport.id),
            payload: { orderId, modality, impression }
          });
          appendAudit(actor, 'RADIOLOGY_REPORTED', 'radiology_report', newReport.id, { orderId, modality });
          return sendJson(res, 201, enrichRadiologyReport(newReport));
        }

        // ADT (Beds, Admissions, Transfers, Discharge, Cleaning)
        if (pathname === '/api/beds' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const rows = db.beds.map(b => {
            let pat = null;
            if (b.currentEncounterId) {
              const enc = db.encounters.find(e => e.id === b.currentEncounterId);
              if (enc) pat = db.patients.find(p => p.id === enc.patientId);
            }
            return {
              ...b,
              mrn: pat?.mrn || null,
              givenName: pat?.givenName || null,
              familyName: pat?.familyName || null,
              patientName: formatFullName(pat)
            };
          });
          return sendJson(res, 200, rows);
        }

        if (pathname === '/api/admissions' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const rows = db.admissions.map(a => {
            const enc = db.encounters.find(e => e.id === a.encounterId) || {};
            const pat = db.patients.find(p => p.id === enc.patientId) || {};
            const bed = db.beds.find(b => b.id === a.bedId) || {};
            return {
              ...a,
              ward: bed.ward || null,
              room: bed.room || null,
              bedNo: bed.bedNo || null,
              mrn: pat.mrn || null,
              givenName: pat.givenName || null,
              familyName: pat.familyName || null,
              patientName: formatFullName(pat)
            };
          }).sort((a, b) => b.id - a.id);
          return sendJson(res, 200, rows);
        }

        if (pathname === '/api/admissions' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const body = await parseJsonBody(req);
          const encounterId = Number(body.encounterId ?? body.encounter_id);
          const bedId = Number(body.bedId ?? body.bed_id);
          const enc = db.encounters.find(e => e.id === encounterId);
          const bed = db.beds.find(b => b.id === bedId);
          if (!enc || !bed) return sendJson(res, 404, { error: 'Başvuru veya yatak bulunamadı.' });
          if (enc.status !== 'Open') return sendJson(res, 409, { error: 'Yalnızca açık başvuru yatışa alınabilir.' });
          if (bed.status !== 'Available') return sendJson(res, 409, { error: 'Seçilen yatak uygun durumda değil.' });
          if (db.admissions.some(a => a.encounterId === encounterId && a.status === 'Admitted')) {
            return sendJson(res, 409, { error: 'Bu başvuru için zaten aktif yatış mevcut.' });
          }

          bed.status = 'Occupied';
          bed.currentEncounterId = encounterId;
          enc.status = 'Admitted';
          const adm = {
            id: ++db.counters.admission,
            encounterId,
            bedId,
            admittedAt: new Date().toISOString(),
            dischargedAt: null,
            status: 'Admitted'
          };
          db.admissions.unshift(adm);
          appendAudit(actor, 'PATIENT_ADMITTED', 'admission', adm.id, { bedNo: bed.bedNo });
          return sendJson(res, 201, adm);
        }

        const transfersGetMatch = pathname.match(/^\/api\/admissions\/(\d+)\/transfers$/);
        if (transfersGetMatch && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const admissionId = Number(transfersGetMatch[1]);
          const adm = db.admissions.find(a => a.id === admissionId);
          if (!adm) return sendJson(res, 404, { error: 'Yatış kaydı bulunamadı.' });
          const history = db.bedTransfers
            .filter(t => t.admissionId === admissionId)
            .sort((a, b) => b.id - a.id);
          return sendJson(res, 200, history);
        }

        const transferPostMatch = pathname.match(/^\/api\/admissions\/(\d+)\/transfer$/);
        if (transferPostMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const admissionId = Number(transferPostMatch[1]);
          const body = await parseJsonBody(req);
          const admission = db.admissions.find(a => a.id === admissionId);
          if (!admission) return sendJson(res, 404, { error: 'Yatış kaydı bulunamadı.' });
          if (admission.status !== 'Admitted') return sendJson(res, 409, { error: 'Yalnızca aktif yatış transfer edilebilir.' });

          const newBedId = Number(body.newBedId ?? body.toBedId ?? body.new_bed_id);
          if (newBedId === admission.bedId) return sendJson(res, 400, { error: 'Hedef yatak mevcut yataktan farklı olmalıdır.' });
          const newBed = db.beds.find(b => b.id === newBedId);
          if (!newBed) return sendJson(res, 404, { error: 'Hedef yatak bulunamadı.' });
          if (newBed.status !== 'Available') return sendJson(res, 409, { error: 'Hedef yatak müsait değil.' });

          const oldBed = db.beds.find(b => b.id === admission.bedId);
          if (oldBed) {
            oldBed.status = 'Cleaning';
            oldBed.currentEncounterId = null;
          }
          newBed.status = 'Occupied';
          newBed.currentEncounterId = admission.encounterId;
          admission.bedId = newBed.id;

          const reason = String(body.reason || 'Servis içi yatak transferi').trim();
          const transfer = {
            id: ++db.counters.bedTransfer,
            admissionId,
            fromBedId: oldBed ? oldBed.id : null,
            fromBedNo: oldBed ? oldBed.bedNo : null,
            fromWard: oldBed ? oldBed.ward : null,
            toBedId: newBed.id,
            toBedNo: newBed.bedNo,
            toWard: newBed.ward,
            transferredBy: actor.displayName,
            reason,
            transferredAt: new Date().toISOString()
          };
          db.bedTransfers.unshift(transfer);
          appendAudit(actor, 'BED_TRANSFERRED', 'admission', admissionId, { from: oldBed?.bedNo, to: newBed.bedNo, reason });
          return sendJson(res, 200, {
            id: admissionId,
            transferId: transfer.id,
            fromBedId: transfer.fromBedId,
            toBedId: transfer.toBedId,
            oldBedStatus: 'Cleaning',
            transfer
          });
        }

        const dischargeMatch = pathname.match(/^\/api\/admissions\/(\d+)\/discharge$/);
        if (dischargeMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const admissionId = Number(dischargeMatch[1]);
          const admission = db.admissions.find(a => a.id === admissionId);
          if (!admission) return sendJson(res, 404, { error: 'Yatış bulunamadı.' });
          if (admission.status !== 'Admitted') return sendJson(res, 409, { error: 'Hasta zaten taburcu edilmiş.' });

          const nowIso = new Date().toISOString();
          admission.status = 'Discharged';
          admission.dischargedAt = nowIso;
          const bed = db.beds.find(b => b.id === admission.bedId);
          if (bed) {
            bed.status = 'Cleaning';
            bed.currentEncounterId = null;
          }
          const enc = db.encounters.find(e => e.id === admission.encounterId);
          if (enc) {
            enc.status = 'Discharged';
            enc.closedAt = nowIso;
          }
          appendAudit(actor, 'PATIENT_DISCHARGED', 'admission', admissionId);
          return sendJson(res, 200, { id: admissionId, status: 'Discharged', bedStatus: 'Cleaning' });
        }

        const bedCleanMatch = pathname.match(/^\/api\/beds\/(\d+)\/cleaning-complete$/);
        if (bedCleanMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'nurse']);
          const bedId = Number(bedCleanMatch[1]);
          const bed = db.beds.find(b => b.id === bedId);
          if (!bed) return sendJson(res, 404, { error: 'Yatak bulunamadı.' });
          if (bed.status !== 'Cleaning') return sendJson(res, 409, { error: 'Yalnızca temizlikteki yatak kullanıma açılabilir.' });
          bed.status = 'Available';
          bed.currentEncounterId = null;
          appendAudit(actor, 'BED_CLEANING_COMPLETED', 'bed', bedId);
          return sendJson(res, 200, { id: bedId, status: 'Available', bed });
        }

        // Pharmacy: Drugs, Stock Receipt + Idempotency, Movements, Prescriptions + Allergy CDS + Atomic Dispense
        if (pathname === '/api/drugs' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'pharmacist']);
          return sendJson(res, 200, db.drugs);
        }

        const drugMovementsMatch = pathname.match(/^\/api\/drugs\/(\d+)\/movements$/);
        if (drugMovementsMatch && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'pharmacist']);
          const drugId = Number(drugMovementsMatch[1]);
          const drug = db.drugs.find(d => d.id === drugId);
          if (!drug) return sendJson(res, 404, { error: 'İlaç bulunamadı.' });
          return sendJson(res, 200, db.stockMovements.filter(m => m.drugId === drugId));
        }

        const stockReceiptAliasMatch = pathname.match(/^\/api\/drugs\/(\d+)\/stock-receipts$/);
        if ((pathname === '/api/drugs/stock-receipt' || stockReceiptAliasMatch) && method === 'POST') {
          requireRoles(actor, ['admin', 'pharmacist']);
          const body = await parseJsonBody(req);
          const drugId = stockReceiptAliasMatch ? Number(stockReceiptAliasMatch[1]) : Number(body.drugId ?? body.drug_id);
          const drug = db.drugs.find(d => d.id === drugId && d.active);
          if (!drug) return sendJson(res, 404, { error: 'İlaç bulunamadı.' });

          const qty = Number(body.quantity ?? body.qty);
          if (!Number.isInteger(qty) || qty <= 0 || qty > 100000) {
            return sendJson(res, 400, { error: 'Teslim alınan miktar 1-100000 arası tam sayı olmalıdır.' });
          }
          const referenceNo = String(body.referenceNo ?? body.reference ?? '').trim();
          const idemHeader = String(req.headers['idempotency-key'] || '').trim();
          const effectiveRef = referenceNo || idemHeader;
          if (!effectiveRef) {
            return sendJson(res, 400, { error: 'İrsaliye referansı veya Idempotency-Key zorunludur.' });
          }

          if (idemHeader && db.idempotencyKeys.has(idemHeader)) {
            const prev = db.idempotencyKeys.get(idemHeader);
            if (prev.drugId !== drugId || prev.qty !== qty) {
              return sendJson(res, 409, { error: 'Bu Idempotency-Key daha önce farklı bir ilaç/miktar ile kullanılmış.' });
            }
            return sendJson(res, 200, {
              deduplicated: true,
              drugId,
              receivedQuantity: qty,
              stock: drug.stock,
              drug,
              movement: prev.movement
            });
          }

          const existingRef = db.stockMovements.find(m =>
            m.drugId === drugId && m.movementType === 'RECEIPT' &&
            String(m.referenceNo || '').toLowerCase() === effectiveRef.toLowerCase()
          );
          if (existingRef) {
            if (existingRef.qtyDelta !== qty) {
              return sendJson(res, 409, { error: 'Bu irsaliye aynı ilaç için daha önce farklı miktarla kaydedilmiş.' });
            }
            return sendJson(res, 200, {
              deduplicated: true,
              drugId,
              receivedQuantity: qty,
              stock: drug.stock,
              drug,
              movement: existingRef
            });
          }

          drug.stock += qty;
          const movement = {
            id: ++db.counters.stockMovement,
            drugId,
            prescriptionId: null,
            movementType: 'RECEIPT',
            qtyDelta: qty,
            referenceNo: effectiveRef,
            actor: actor.username,
            createdAt: new Date().toISOString()
          };
          db.stockMovements.unshift(movement);
          if (idemHeader) db.idempotencyKeys.set(idemHeader, { drugId, qty, movement });

          pushIntegration({
            target: 'İTS / ÜTS (Ürün Takip Sistemi)', eventType: 'StokAlmaBildirimi',
            aggregateType: 'drug', aggregateId: drug.code,
            payload: { drug: drug.name, addedQty: qty, currentStock: drug.stock, referenceNo: effectiveRef }
          });
          appendAudit(actor, 'DRUG_STOCK_RECEIPT', 'drug', drugId, { quantity: qty, referenceNo: effectiveRef, stockAfter: drug.stock });
          return sendJson(res, 200, {
            deduplicated: false,
            drugId,
            receivedQuantity: qty,
            stock: drug.stock,
            drug,
            movement
          });
        }

        if (pathname === '/api/prescriptions' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'pharmacist']);
          return sendJson(res, 200, db.prescriptions.map(enrichPrescription).sort((a, b) => b.id - a.id));
        }

        if (pathname === '/api/prescriptions' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor']);
          const body = await parseJsonBody(req);
          const encounterId = Number(body.encounterId ?? body.encounter_id);
          const enc = db.encounters.find(e => e.id === encounterId && ['Open', 'Admitted'].includes(e.status));
          if (!enc) return sendJson(res, 404, { error: 'Aktif başvuru bulunamadı.' });
          const patient = db.patients.find(p => p.id === enc.patientId);
          if (!patient) return sendJson(res, 404, { error: 'Hasta bulunamadı.' });

          const rawItems = Array.isArray(body.items) ? body.items : [];
          if (rawItems.length === 0 || rawItems.length > 30) {
            return sendJson(res, 400, { error: '1-30 arası ilaç kalemi gereklidir.' });
          }

          const parsedItems = [];
          for (const rawItem of rawItems) {
            const drugId = Number(rawItem.drugId ?? rawItem.drug_id);
            const drug = db.drugs.find(d => d.id === drugId && d.active);
            if (!drug) return sendJson(res, 404, { error: `İlaç bulunamadı: ${drugId}` });
            const quantity = Number(rawItem.quantity ?? rawItem.qty ?? 1);
            const durationDays = Number(rawItem.durationDays ?? rawItem.duration_days ?? 7);
            const dosage = String(rawItem.dosage || '').trim();
            const frequency = String(rawItem.frequency || '').trim();
            if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(durationDays) || durationDays <= 0 || !dosage || !frequency) {
              return sendJson(res, 400, { error: 'Her reçete kalemi için ilaç, doz, sıklık, süre (>0) ve miktar (>0) geçerli olmalıdır.' });
            }
            parsedItems.push({
              drug,
              item: {
                drugId,
                dosage,
                frequency,
                durationDays,
                quantity,
                dispensedQty: 0,
                usage: rawItem.usage ? String(rawItem.usage).trim() : null,
                utsBarcode: drug.barcode
              }
            });
          }

          // Drug-Allergy CDS Check
          const overrideAllergy = Boolean(body.overrideAllergy ?? body.override_allergy);
          const overrideReason = String(body.overrideReason ?? body.override_reason ?? '').trim();
          const conflicts = [];
          for (const { drug } of parsedItems) {
            const allergyMatch = matchDrugAllergyConflict(patient.allergies, drug);
            if (allergyMatch) {
              conflicts.push({ allergy: allergyMatch, drugName: drug.name, drugId: drug.id });
            }
          }

          if (conflicts.length > 0 && !(overrideAllergy && overrideReason.length >= 5)) {
            return sendJson(res, 409, {
              error: 'Alerji çakışması tespit edildi',
              code: 'ALLERGY_CONFLICT',
              allergy: conflicts[0].allergy,
              drugName: conflicts[0].drugName,
              drugId: conflicts[0].drugId,
              requiresOverrideReason: true
            });
          }

          const nextId = ++db.counters.prescription;
          const medulaEreceteNo = `26${crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
          const newRx = {
            id: nextId,
            encounterId,
            prescribedBy: actor.displayName,
            status: 'Pending',
            createdAt: new Date().toISOString(),
            dispensedAt: null,
            dispensedBy: null,
            medulaEreceteNo,
            tesisKodu: '11340001',
            overrideAllergy: conflicts.length > 0,
            overrideReason: conflicts.length > 0 ? overrideReason : null,
            items: parsedItems.map(x => x.item)
          };
          db.prescriptions.unshift(newRx);

          if (conflicts.length > 0) {
            appendAudit(actor, 'ALLERGY_OVERRIDE', 'prescription', newRx.id, {
              patientId: patient.id,
              conflicts,
              overrideReason
            });
          }

          pushIntegration({
            target: 'SGK MEDULA Gateway', eventType: 'eRecete_Kayit',
            aggregateType: 'prescription', aggregateId: `RX-${newRx.id}`,
            payload: { medulaEreceteNo, doctor: actor.displayName, itemCount: newRx.items.length }
          });
          appendAudit(actor, 'PRESCRIPTION_CREATED', 'prescription', newRx.id, { medulaEreceteNo, itemCount: newRx.items.length });
          return sendJson(res, 201, enrichPrescription(newRx));
        }

        const dispenseMatch = pathname.match(/^\/api\/prescriptions\/(\d+)\/dispense$/);
        if (dispenseMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'pharmacist']);
          const rxId = Number(dispenseMatch[1]);
          const rx = db.prescriptions.find(p => p.id === rxId);
          if (!rx) return sendJson(res, 404, { error: 'Reçete bulunamadı.' });
          if (rx.status !== 'Pending') {
            return sendJson(res, 409, { error: 'Yalnızca bekleyen (Pending) reçete karşılanabilir.' });
          }

          // Atomic pre-validation across all items before mutating any stock
          const requiredByDrug = new Map();
          for (const item of rx.items || []) {
            requiredByDrug.set(item.drugId, (requiredByDrug.get(item.drugId) || 0) + (item.quantity || 1));
          }
          for (const [drugId, totalRequired] of requiredByDrug.entries()) {
            const drug = db.drugs.find(d => d.id === drugId && d.active);
            if (!drug) return sendJson(res, 404, { error: `İlaç bulunamadı: ${drugId}` });
            if (drug.stock < totalRequired) {
              return sendJson(res, 409, {
                error: `Yetersiz stok: ${drug.name} (Mevcut: ${drug.stock}, İstenen: ${totalRequired})`,
                code: 'INSUFFICIENT_STOCK',
                drugId: drug.id,
                drugName: drug.name,
                availableStock: drug.stock,
                requestedQty: totalRequired
              });
            }
          }

          const nowIso = new Date().toISOString();
          for (const item of rx.items || []) {
            const qty = item.quantity || 1;
            const drug = db.drugs.find(d => d.id === item.drugId);
            drug.stock -= qty;
            item.dispensedQty = qty;
            db.stockMovements.unshift({
              id: ++db.counters.stockMovement,
              drugId: drug.id,
              prescriptionId: rxId,
              movementType: 'DISPENSE',
              qtyDelta: -qty,
              referenceNo: `RX-${rxId}`,
              actor: actor.username,
              createdAt: nowIso
            });
          }

          rx.status = 'Dispensed';
          rx.dispensedAt = nowIso;
          rx.dispensedBy = actor.displayName;

          pushIntegration({
            target: 'İTS / ÜTS (Ürün Takip Sistemi)', eventType: 'KarekodTuketimBildirimi',
            aggregateType: 'prescription', aggregateId: `RX-${rxId}`,
            payload: { prescriptionId: rxId, dispensedBy: actor.displayName }
          });
          appendAudit(actor, 'PRESCRIPTION_DISPENSED', 'prescription', rxId, { itemCount: (rx.items || []).length });
          return sendJson(res, 200, { ok: true, status: 'Dispensed', prescription: enrichPrescription(rx) });
        }

        // Billing & Multi-line Invoices
        if (pathname === '/api/invoices' && method === 'GET') {
          requireRoles(actor, ['admin', 'billing', 'registrar']);
          const rows = db.invoices.map(i => {
            const enc = db.encounters.find(e => e.id === i.encounterId) || {};
            const pat = db.patients.find(p => p.id === enc.patientId) || {};
            return {
              ...i,
              lineCount: (i.lines || []).length,
              mrn: pat.mrn || null,
              givenName: pat.givenName || null,
              familyName: pat.familyName || null,
              patientName: formatFullName(pat)
            };
          }).sort((a, b) => b.id - a.id);
          return sendJson(res, 200, rows);
        }

        if (pathname === '/api/invoices' && method === 'POST') {
          requireRoles(actor, ['admin', 'billing']);
          const body = await parseJsonBody(req);
          const encounterId = Number(body.encounterId ?? body.encounter_id);
          const enc = db.encounters.find(e => e.id === encounterId);
          if (!enc) return sendJson(res, 404, { error: 'Başvuru bulunamadı.' });
          const payer = String(body.payer || 'SGK').trim() || 'SGK';

          let lines = [];
          if (Array.isArray(body.lines)) {
            if (body.lines.length === 0) return sendJson(res, 400, { error: 'Fatura en az bir hizmet kalemi içermelidir.' });
            lines = body.lines.map((l, i) => {
              const code = String(l.code || `SUT-${i + 1}`).trim();
              const description = String(l.description || '').trim();
              if (!description) throw new HttpError(400, `Kalem #${i + 1} açıklaması zorunludur.`);
              const qty = parsePositiveMoney(l.qty ?? l.quantity ?? 1, `Kalem #${i + 1} miktar`, 100000);
              const unitPrice = parsePositiveMoney(l.unitPrice ?? l.unit_price, `Kalem #${i + 1} birim fiyat`);
              const lineTotal = roundMoney(qty * unitPrice);
              return { code, description, qty, unitPrice, lineTotal };
            });
          } else if (body.amount !== undefined) {
            const amount = parsePositiveMoney(body.amount, 'Fatura tutarı');
            lines = [{
              code: String(body.code || '520.010').trim(),
              description: String(body.description || 'Klinik Hizmet Bedeli').trim(),
              qty: 1,
              unitPrice: amount,
              lineTotal: amount
            }];
          } else {
            const qty = parsePositiveMoney(body.qty ?? body.quantity ?? 1, 'Miktar', 100000);
            const unitPrice = parsePositiveMoney(body.unitPrice ?? body.unit_price, 'Birim fiyat');
            const lineTotal = roundMoney(qty * unitPrice);
            lines = [{
              code: String(body.code || '520.010').trim(),
              description: String(body.description || 'Klinik Hizmet').trim(),
              qty,
              unitPrice,
              lineTotal
            }];
          }

          const totalAmount = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
          const patientShare = payer === 'SGK' ? Math.min(15.00, totalAmount) : totalAmount;
          const sgkShare = payer === 'SGK' ? roundMoney(Math.max(0, totalAmount - patientShare)) : 0;
          const nextId = ++db.counters.invoice;
          const medulaTakipNo = enc.medulaTakipNo || `2603${Math.floor(10000000 + Math.random() * 90000000)}`;

          const newInvoice = {
            id: nextId,
            encounterId,
            invoiceNo: `DEMO-INV-2026-${String(nextId).padStart(3, '0')}`,
            payer,
            status: 'Issued',
            currency: String(body.currency || 'TRY'),
            totalAmount,
            sgkShare,
            patientShare,
            medulaTakipNo,
            medulaDurum: 'GSS Fatura Gönderildi (İncelemede)',
            createdAt: new Date().toISOString(),
            paidAt: null,
            lines
          };
          db.invoices.unshift(newInvoice);

          pushIntegration({
            target: 'SGK MEDULA Gateway', eventType: 'Fatura_GSS_Iletim',
            aggregateType: 'invoice', aggregateId: newInvoice.invoiceNo,
            payload: { invoiceNo: newInvoice.invoiceNo, totalAmount, medulaTakipNo }
          });
          appendAudit(actor, 'INVOICE_CREATED', 'invoice', newInvoice.id, { invoiceNo: newInvoice.invoiceNo, totalAmount });
          return sendJson(res, 201, newInvoice);
        }

        const invoicePayMatch = pathname.match(/^\/api\/invoices\/(\d+)\/pay$/);
        if (invoicePayMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'billing']);
          const id = Number(invoicePayMatch[1]);
          const invoice = db.invoices.find(i => i.id === id);
          if (!invoice) return sendJson(res, 404, { error: 'Fatura bulunamadı.' });
          if (invoice.status !== 'Issued') return sendJson(res, 409, { error: 'Yalnızca düzenlenmiş (Issued) fatura tahsil edilebilir.' });
          invoice.status = 'Paid';
          invoice.paidAt = new Date().toISOString();
          invoice.medulaDurum = 'Tahsil Edildi (SGK & Vezne)';
          appendAudit(actor, 'INVOICE_PAID', 'invoice', id, { totalAmount: invoice.totalAmount });
          return sendJson(res, 200, { ok: true, status: 'Paid', invoice });
        }

        // Vaccinations
        if (pathname === '/api/vaccinations' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'registrar']);
          const rows = db.vaccinations.map(v => {
            const pat = db.patients.find(p => p.id === v.patientId) || {};
            return { ...v, mrn: pat.mrn || null, givenName: pat.givenName || null, familyName: pat.familyName || null, patientName: formatFullName(pat) };
          }).sort((a, b) => b.id - a.id);
          return sendJson(res, 200, rows);
        }

        if (pathname === '/api/vaccinations' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse']);
          const body = await parseJsonBody(req);
          const patientId = Number(body.patientId ?? body.patient_id);
          const pat = db.patients.find(p => p.id === patientId && p.active);
          if (!pat) return sendJson(res, 404, { error: 'Hasta bulunamadı.' });
          const vaccineCode = String(body.vaccineCode ?? body.vaccine_code ?? '').trim();
          const vaccineName = String(body.vaccineName ?? body.vaccine_name ?? '').trim();
          const doseNo = Number(body.doseNo ?? body.dose_no ?? 1);
          if (!vaccineCode || !vaccineName || !Number.isInteger(doseNo) || doseNo < 1 || doseNo > 20) {
            return sendJson(res, 400, { error: 'Aşı kodu, aşı adı ve doz (1-20) zorunludur.' });
          }

          const administeredAt = body.administeredAt ? new Date(body.administeredAt) : new Date();
          if (Number.isNaN(administeredAt.getTime())) return sendJson(res, 400, { error: 'Geçersiz uygulama tarihi.' });
          if (administeredAt.getTime() > Date.now() + 5 * 60000) return sendJson(res, 400, { error: 'Aşı uygulama tarihi gelecekte olamaz.' });
          if (administeredAt.toISOString().slice(0, 10) < pat.birthDate) {
            return sendJson(res, 400, { error: 'Aşı uygulama tarihi hastanın doğum tarihinden önce olamaz.' });
          }

          const nextId = ++db.counters.vaccination;
          const vax = {
            id: nextId,
            patientId,
            vaccineCode,
            vaccineName,
            doseNo,
            lotNo: String(body.lotNo ?? body.lot_no ?? `LOT-${Math.floor(1000 + Math.random() * 9000)}`).trim(),
            administeredAt: administeredAt.toISOString(),
            administeredBy: actor.displayName,
            externalEventId: `VAX-DEMO-${nextId}`
          };
          db.vaccinations.unshift(vax);
          pushIntegration({
            target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: 'Paket401_AsiBildirimi',
            aggregateType: 'vaccine', aggregateId: String(vax.id),
            payload: { asi: vax.vaccineName, lotNo: vax.lotNo, doz: vax.doseNo }
          });
          appendAudit(actor, 'VACCINATION_RECORDED', 'vaccine', vax.id, { vaccineCode, doseNo });
          return sendJson(res, 201, vax);
        }

        // HL7 v2.5.1 ORU^R01 & LIS Inbox
        if (pathname === '/api/lis/inbox' && method === 'GET') {
          requireRoles(actor, ['admin', 'lab', 'integration']);
          return sendJson(res, 200, db.lisInbox);
        }

        if (pathname === '/api/hl7/oru' && method === 'POST') {
          requireRoles(actor, ['admin', 'lab', 'integration']);
          const contentType = String(req.headers['content-type'] || '').toLowerCase();
          let rawMessage = '';
          let sourceSystem = 'HL7-BRIDGE';

          if (contentType.includes('application/json')) {
            const body = await parseJsonBody(req);
            rawMessage = body.rawMessage ?? body.raw_message ?? body.raw ?? '';
            if (body.sourceSystem || body.source_system) sourceSystem = String(body.sourceSystem ?? body.source_system).trim();
          } else {
            const raw = await readRawBody(req);
            if (raw.trim().startsWith('{')) {
              try {
                const parsedJson = JSON.parse(raw);
                rawMessage = parsedJson.rawMessage ?? parsedJson.raw_message ?? parsedJson.raw ?? raw;
                if (parsedJson.sourceSystem || parsedJson.source_system) sourceSystem = String(parsedJson.sourceSystem ?? parsedJson.source_system).trim();
              } catch {
                rawMessage = raw;
              }
            } else {
              rawMessage = raw;
            }
          }

          const parsed = parseHl7Oru(rawMessage);
          const resolvedSource = parsed.sendingApp || sourceSystem;

          // MSH-10 deduplication check
          const existingInbox = db.lisInbox.find(m => m.messageControlId === parsed.controlId);
          if (existingInbox) {
            return sendJson(res, 200, {
              deduplicated: true,
              controlId: parsed.controlId,
              status: 'DuplicateIgnored',
              ack: buildHl7Ack(parsed.controlId, 'AA')
            });
          }

          // Locate order and verify patient MRN match if order exists
          let matchedOrder = db.orders.find(o =>
            String(o.id) === parsed.orderIdentifier || o.externalRef === parsed.orderIdentifier
          );
          const patientByMrn = db.patients.find(p => p.mrn === parsed.patientIdentifier);

          if (!matchedOrder && patientByMrn) {
            const encIds = new Set(db.encounters.filter(e => e.patientId === patientByMrn.id).map(e => e.id));
            matchedOrder = db.orders.find(o => encIds.has(o.encounterId) && o.orderType === 'LAB');
          }

          if (matchedOrder) {
            const ordEnc = db.encounters.find(e => e.id === matchedOrder.encounterId);
            const ordPat = ordEnc ? db.patients.find(p => p.id === ordEnc.patientId) : null;
            if (matchedOrder.orderType !== 'LAB') {
              const errMsg = 'HL7 sonuçları yalnızca laboratuvar (LAB) istemlerine işlenebilir.';
              db.lisInbox.unshift({
                id: ++db.counters.lisInbox, messageControlId: parsed.controlId, sourceSystem: resolvedSource,
                status: 'Failed', receivedAt: new Date().toISOString(), processedAt: new Date().toISOString(), lastError: errMsg
              });
              appendAudit(actor, 'HL7_ORU_REJECTED', 'hl7', parsed.controlId, { error: errMsg });
              return sendJson(res, 200, { deduplicated: false, controlId: parsed.controlId, status: 'Failed', error: errMsg, ack: buildHl7Ack(parsed.controlId, 'AE', errMsg) });
            }
            if (ordPat && ordPat.mrn !== parsed.patientIdentifier) {
              const errMsg = 'OBR-3 istemi ile PID-3 hasta numarası eşleşmedi.';
              db.lisInbox.unshift({
                id: ++db.counters.lisInbox, messageControlId: parsed.controlId, sourceSystem: resolvedSource,
                status: 'Failed', receivedAt: new Date().toISOString(), processedAt: new Date().toISOString(), lastError: errMsg
              });
              appendAudit(actor, 'HL7_ORU_REJECTED', 'hl7', parsed.controlId, { error: errMsg });
              return sendJson(res, 200, { deduplicated: false, controlId: parsed.controlId, status: 'Failed', error: errMsg, ack: buildHl7Ack(parsed.controlId, 'AE', errMsg) });
            }
          }

          const nowIso = new Date().toISOString();
          const createdResults = [];
          for (const obs of parsed.observations) {
            const resObj = {
              id: ++db.counters.labResult,
              orderId: matchedOrder ? matchedOrder.id : 1,
              analyteCode: obs.code,
              display: obs.display,
              value: obs.value,
              unit: obs.unit,
              referenceRange: obs.referenceRange || '',
              flag: obs.flag,
              criticalFlag: obs.criticalFlag,
              criticalAckBy: null,
              criticalAckAt: null,
              criticalAckNote: null,
              communicatedWith: null,
              resultedAt: nowIso
            };
            db.labResults.unshift(resObj);
            createdResults.push(enrichLabResult(resObj));
          }

          if (matchedOrder && matchedOrder.status !== 'Verified') {
            matchedOrder.status = 'Resulted';
            matchedOrder.updatedAt = nowIso;
          }

          db.lisInbox.unshift({
            id: ++db.counters.lisInbox,
            messageControlId: parsed.controlId,
            sourceSystem: resolvedSource,
            status: 'Processed',
            receivedAt: nowIso,
            processedAt: nowIso,
            lastError: null
          });

          pushIntegration({
            target: 'LIS / HL7 v2 (Cihaz Ağı)', eventType: 'ORU_R01_SonucAlimi',
            aggregateType: 'hl7', aggregateId: parsed.controlId,
            payload: { controlId: parsed.controlId, orderId: matchedOrder?.id || null, observationCount: createdResults.length }
          });
          appendAudit(actor, 'HL7_ORU_PROCESSED', 'hl7', parsed.controlId, {
            sendingApp: resolvedSource, observationCount: createdResults.length, orderId: matchedOrder?.id || null
          });

          return sendJson(res, 200, {
            deduplicated: false,
            controlId: parsed.controlId,
            status: 'Processed',
            sendingApp: resolvedSource,
            timestamp: parsed.messageTimestamp,
            patientIdentifier: parsed.patientIdentifier,
            orderId: matchedOrder ? matchedOrder.id : null,
            observationCount: createdResults.length,
            observations: parsed.observations,
            results: createdResults,
            ack: buildHl7Ack(parsed.controlId, 'AA')
          });
        }

        // Integrations Outbox (Payload stripped on GET!)
        if (pathname === '/api/integrations' && method === 'GET') {
          requireRoles(actor, ['admin', 'integration']);
          return sendJson(res, 200, db.integrations.map(stripIntegrationPayload));
        }

        const retryMatch = pathname.match(/^\/api\/integrations\/(\d+)\/retry$/);
        if (retryMatch && method === 'POST') {
          requireRoles(actor, ['admin', 'integration']);
          const id = Number(retryMatch[1]);
          const item = db.integrations.find(i => i.id === id);
          if (!item) return sendJson(res, 404, { error: 'Entegrasyon kaydı bulunamadı.' });
          item.status = 'Sent';
          item.attempts += 1;
          item.lastError = null;
          item.nextAttemptAt = new Date().toISOString();
          appendAudit(actor, 'INTEGRATION_REQUEUED', 'integration', id, { eventType: item.eventType });
          return sendJson(res, 200, { ok: true, item: stripIntegrationPayload(item) });
        }

        // Audit Hash Chain (admin ONLY)
        if (pathname === '/api/audit' && method === 'GET') {
          requireRoles(actor, ['admin']);
          const verification = verifyAuditChain(db.auditEvents);
          const eventsNewestFirst = [...db.auditEvents].reverse().slice(0, 150).map(e => ({
            id: e.id,
            occurredAt: e.occurredAt,
            username: e.username,
            role: e.role,
            action: e.action,
            entityType: e.entityType,
            entityId: e.entityId,
            detailsJson: e.detailsJson,
            previousHash: e.previousHash,
            eventHash: e.eventHash
          }));
          return sendJson(res, 200, {
            chainValid: verification.chainValid,
            verifiedCount: verification.verifiedCount,
            brokenEventId: verification.brokenEventId,
            events: eventsNewestFirst
          });
        }

        // Connectors Hub Endpoints (UNIFIED-CONTRACT.md §2)
        if ((pathname === '/api/connectors/overview' || pathname === '/api/connectors/status') && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'pharmacist', 'billing', 'registrar', 'integration']);
          return sendJson(res, 200, {
            gateways: connectorsConfig,
            counts: {
              totalGateways: Object.keys(connectorsConfig).length,
              allOnline: true,
              totalTrafficToday: db.integrations.length + 840,
              pendingOutbox: db.integrations.filter(i => i.status !== 'Sent').length,
              failedOutbox: db.integrations.filter(i => i.status === 'Failed').length
            },
            outbox: db.integrations.slice(0, 10).map(stripIntegrationPayload)
          });
        }

        // MHRS
        if (pathname === '/api/connectors/mhrs/appointments' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'registrar', 'integration']);
          const q = (parsedUrl.searchParams.get('q') || '').trim().toLocaleLowerCase('tr');
          const list = db.mhrsAppointments.filter(a =>
            !q || `${a.id} ${a.patientName} ${a.patientRef} ${a.doctor} ${a.polyclinic}`.toLocaleLowerCase('tr').includes(q)
          );
          return sendJson(res, 200, list);
        }

        if (pathname === '/api/connectors/mhrs/sync' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'registrar', 'integration']);
          appendAudit(actor, 'MHRS_SYNC_EXECUTED', 'mhrs', 'all');
          return sendJson(res, 200, { ok: true, count: db.mhrsAppointments.length, appointments: db.mhrsAppointments });
        }

        if (pathname === '/api/connectors/mhrs/admit' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'registrar', 'integration']);
          const body = await parseJsonBody(req);
          const appointmentId = body.appointmentId ?? body.appointment_id;
          const appt = db.mhrsAppointments.find(a => a.id === appointmentId);
          if (!appt) return sendJson(res, 404, { error: 'MHRS randevusu bulunamadı.' });
          if (appt.status === 'Admitted' && appt.encounterId) {
            return sendJson(res, 409, { error: 'Bu randevu için zaten kabul işlemi yapılmış.' });
          }

          const nextEncId = ++db.counters.encounter;
          const medulaTakipNo = `2603${Math.floor(10000000 + Math.random() * 90000000)}`;
          const sysTakipNo = `SYS-2026-TR-${Math.floor(1000 + Math.random() * 9000)}`;
          const newEncounter = {
            id: nextEncId,
            patientId: appt.patientId,
            encounterType: 'Outpatient',
            status: 'Open',
            chiefComplaint: `MHRS Randevulu Kabul: ${appt.polyclinic} - ${appt.doctor}`,
            openedAt: new Date().toISOString(),
            closedAt: null,
            externalRef: `MHRS-ENC-${appt.id}`,
            medulaTakipNo,
            sysTakipNo,
            mhrsRandevuId: appt.id,
            ulakProtokolNo: null
          };
          db.encounters.unshift(newEncounter);
          appt.status = 'Admitted';
          appt.encounterId = newEncounter.id;
          appt.medulaTakipNo = medulaTakipNo;

          pushIntegration({
            target: 'MHRS Gateway (Bakanlık)', eventType: 'RandevuKabulBildirimi',
            aggregateType: 'mhrs', aggregateId: appt.id,
            payload: { appointmentId: appt.id, encounterId: newEncounter.id, medulaTakipNo }
          });
          appendAudit(actor, 'MHRS_APPOINTMENT_ADMITTED', 'mhrs', appt.id, { encounterId: newEncounter.id });
          return sendJson(res, 200, { ok: true, encounter: enrichEncounter(newEncounter), appointment: appt });
        }

        // ULAK 112
        if (pathname === '/api/connectors/ulak/cases' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'integration']);
          return sendJson(res, 200, db.ulakCases);
        }

        if ((pathname === '/api/connectors/ulak/dispatch' || pathname === '/api/connectors/ulak/cases') && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'integration']);
          const body = await parseJsonBody(req);
          const nextNum = 901 + db.ulakCases.length;
          const rawPrio = String(body.priority ?? body.triageLevel ?? body.triageCode ?? body.emergencyLevel ?? 'YELLOW').trim().toUpperCase();
          const normalizedTriage = ['RED', 'YELLOW', 'GREEN'].includes(rawPrio) ? rawPrio : 'YELLOW';
          const normalizedPriority = normalizedTriage === 'RED' ? 'Red' : (normalizedTriage === 'GREEN' ? 'Green' : 'Yellow');
          const location = String(body.location ?? body.incidentLocation ?? 'Acil 112 Komuta İstasyonu').trim();
          const etaMinutes = Number(body.etrMinutes ?? body.etaMinutes ?? 8);
          const newCase = {
            id: `ULAK-112-${nextNum}`,
            patientId: Number(body.patientId || 11),
            patientName: String(body.patientName || 'Selin Aydın (19K)'),
            patientRef: maskTckn('30192840192'),
            teamCode: String(body.teamCode || '34-MAL-112'),
            ambulancePlate: String(body.ambulancePlate || '34 AS 1199'),
            priority: normalizedPriority,
            triageCode: normalizedTriage,
            triageLevel: normalizedTriage,
            triageTitle: String(body.triageTitle || (normalizedTriage === 'RED' ? 'KIRMIZI ALAN (Kritik)' : normalizedTriage === 'GREEN' ? 'YEŞİL ALAN (Ayaktan)' : 'SARI ALAN (Acil Gözlem)')),
            location,
            incidentSummary: String(body.incidentSummary ?? body.chiefComplaint ?? '112 ASOS ambulans vaka transferi, vital stabilizasyon sağlandı.').slice(0, 500),
            vitals: body.vitals || { bp: '95/60 mmHg', pulse: 92, spo2: 97, gcs: 15, bloodSugar: 88, temp: 36.5 },
            etaMinutes,
            etrMinutes: etaMinutes,
            status: 'EnRoute',
            encounterId: null,
            bedAssigned: null,
            createdAt: new Date().toISOString(),
            arrivedAt: null
          };
          db.ulakCases.unshift(newCase);
          pushIntegration({
            target: 'ULAK 112 Acil Vaka Ağı', eventType: 'YeniVakaBildirimi',
            aggregateType: 'emergency', aggregateId: newCase.id,
            payload: { protokolNo: newCase.id, triage: newCase.triageLevel }
          });
          appendAudit(actor, 'ULAK_DISPATCH_RECEIVED', 'emergency', newCase.id);
          return sendJson(res, 201, newCase);
        }

        if (pathname === '/api/connectors/ulak/admit' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'integration']);
          const body = await parseJsonBody(req);
          const caseId = body.caseId ?? body.case_id;
          const caseItem = db.ulakCases.find(u => u.id === caseId);
          if (!caseItem) return sendJson(res, 404, { error: 'ULAK 112 vakası bulunamadı.' });
          if (caseItem.status === 'InHospital' && caseItem.encounterId) {
            return sendJson(res, 409, { error: 'Bu 112 vakası zaten hastaneye kabul edilmiş.' });
          }

          const nextEncId = ++db.counters.encounter;
          const medulaTakipNo = `2603${Math.floor(10000000 + Math.random() * 90000000)}`;
          const sysTakipNo = `SYS-2026-TR-${Math.floor(1000 + Math.random() * 9000)}`;
          const newEncounter = {
            id: nextEncId,
            patientId: caseItem.patientId,
            encounterType: 'Emergency',
            status: 'Admitted',
            chiefComplaint: `112 ULAK Nakli: ${caseItem.triageTitle} - ${caseItem.incidentSummary}`,
            openedAt: new Date().toISOString(),
            closedAt: null,
            externalRef: `ULAK-ENC-${caseItem.id}`,
            medulaTakipNo,
            sysTakipNo,
            mhrsRandevuId: null,
            ulakProtokolNo: caseItem.id
          };
          db.encounters.unshift(newEncounter);
          caseItem.status = 'InHospital';
          caseItem.encounterId = newEncounter.id;
          caseItem.arrivedAt = new Date().toISOString();
          caseItem.etaMinutes = 0;
          caseItem.bedAssigned = caseItem.triageLevel === 'RED' ? 'KIRMIZI-1' : 'SARI-2';

          pushIntegration({
            target: 'ULAK 112 Acil Vaka Ağı', eventType: 'VakaKabulBildirimi',
            aggregateType: 'emergency', aggregateId: caseItem.id,
            payload: { protokolNo: caseItem.id, bed: caseItem.bedAssigned }
          });
          appendAudit(actor, 'ULAK_EMERGENCY_TRIAGE_ADMIT', 'emergency', caseItem.id, { encounterId: newEncounter.id });
          return sendJson(res, 200, { ok: true, case: caseItem, encounter: enrichEncounter(newEncounter) });
        }

        // MEDULA
        if (pathname === '/api/connectors/medula/provisions' && method === 'GET') {
          requireRoles(actor, ['admin', 'billing', 'registrar', 'integration']);
          return sendJson(res, 200, db.medulaProvisions);
        }

        if (pathname === '/api/connectors/medula/provision' && method === 'POST') {
          requireRoles(actor, ['admin', 'billing', 'registrar', 'integration']);
          const body = await parseJsonBody(req);
          const tckn = String(body.tckn || '28491028472').trim();
          const bransKodu = String(body.bransKodu ?? body.brans_kodu ?? '1000').trim();
          const sigortaliTuru = String(body.sigortaliTuru ?? body.sigortali_turu ?? '4A (SSK Aktif Çalışan)').trim();
          const provizyonTipi = String(body.provizyonTipi ?? body.provizyon_tipi ?? 'Normal').trim();
          const takipNo = `2603${Math.floor(10000000 + Math.random() * 90000000)}`;
          const katilimPayi = provizyonTipi === 'Acil' ? 0.00 : 15.00;

          const nowIso = new Date().toISOString();
          const result = {
            takipNo,
            patientRef: maskTckn(tckn),
            sigortaliTuru,
            bransKodu,
            provizyonTipi,
            katilimPayi,
            sonucKodu: '0000',
            sonucMesaji: 'Hak sahipliği doğrulandı. Müstehaktır.',
            sorgulamaZamani: nowIso,
            createdAt: nowIso,
            gssTesisKodu: '11340001'
          };
          db.medulaProvisions.unshift({ ...result, encounterId: body.encounterId || null });
          pushIntegration({
            target: 'SGK MEDULA Gateway', eventType: 'GSS_ProvizyonSorgu',
            aggregateType: 'medula', aggregateId: takipNo,
            payload: result
          });
          appendAudit(actor, 'MEDULA_PROVISION_FETCHED', 'medula', takipNo, { bransKodu });
          return sendJson(res, 200, result);
        }

        // e-Nabız / USS
        if (pathname === '/api/connectors/enabiz/packages' && method === 'GET') {
          requireRoles(actor, ['admin', 'doctor', 'integration']);
          return sendJson(res, 200, db.enabizPackages);
        }

        if ((pathname === '/api/connectors/enabiz/send' || pathname === '/api/connectors/uss/send') && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'integration']);
          const body = await parseJsonBody(req);
          const packageType = String(body.packageType ?? body.package_type ?? 'Paket101_HastaKayit').trim();
          const patientId = body.patientId ? Number(body.patientId) : null;
          const encounterId = body.encounterId ? Number(body.encounterId) : null;
          const sysTakipNo = `SYS-2026-TR-${Math.floor(1000 + Math.random() * 9000)}`;
          const nowIso = new Date().toISOString();

          const pkg = {
            id: ++db.counters.enabizPackage,
            sysTakipNo,
            packageType,
            patientId,
            encounterId,
            status: 'Sent',
            responseCode: 'SYS_0000',
            responseMessage: 'Sağlık Bakanlığı USS e-Nabız servisi paketi başarıyla kabul etti.',
            sentAt: nowIso
          };
          db.enabizPackages.unshift(pkg);
          pushIntegration({
            target: 'USS / e-Nabız (Sağlık Bakanlığı)', eventType: packageType,
            aggregateType: encounterId ? 'encounter' : 'patient',
            aggregateId: String(encounterId || patientId || sysTakipNo),
            payload: pkg
          });
          appendAudit(actor, 'USS_PACKAGE_SENT', 'uss', sysTakipNo, { packageType });
          return sendJson(res, 200, pkg);
        }

        // İTS / ÜTS Barcode Verify
        if ((pathname === '/api/connectors/its/verify' || pathname === '/api/connectors/uts/verify') && method === 'POST') {
          requireRoles(actor, ['admin', 'pharmacist', 'integration']);
          const body = await parseJsonBody(req);
          const barcode = String(body.barcode || '8699525010050').trim();
          const drug = db.drugs.find(d => d.barcode === barcode || d.utsCode === barcode || d.code === barcode) || db.drugs[0];
          const serialNo = `GS1-128-${Math.floor(1000000 + Math.random() * 9000000)}`;
          const result = {
            verified: true,
            valid: true,
            barcode,
            serialNo,
            serialNumber: serialNo,
            itsCode: drug.utsCode,
            utsCode: drug.utsCode,
            drugId: drug.id,
            stockQty: drug.stock,
            productName: drug.name,
            genericName: drug.genericName,
            producer: 'Türkiye İlaç Sanayi A.Ş.',
            productionDate: '2025-10-15',
            expiryDate: '2028-10-15',
            lotNo: `LOT-${drug.code}-26`,
            status: 'Kayıtlı ve Satışa Uygun'
          };
          appendAudit(actor, 'ITS_BARCODE_VERIFIED', 'its', barcode, { drugCode: drug.code });
          return sendJson(res, 200, result);
        }

        // Legacy connector simulate endpoint (requires matching role)
        if (pathname === '/api/connectors/simulate' && method === 'POST') {
          requireRoles(actor, ['admin', 'doctor', 'nurse', 'lab', 'integration']);
          const body = await parseJsonBody(req);
          const eventType = String(body.eventType ?? body.event_type ?? 'ambulance');
          if (eventType === 'ambulance') {
            requireRoles(actor, ['admin', 'doctor', 'nurse', 'integration']);
            const nextCaseNum = 901 + db.ulakCases.length;
            const newCase = {
              id: `ULAK-112-${nextCaseNum}`,
              patientId: 11,
              patientName: 'Selin Aydın (19K)',
              patientRef: maskTckn('30192840192'),
              teamCode: '34-MAL-112',
              ambulancePlate: '34 AS 1199',
              triageLevel: 'YELLOW',
              triageTitle: 'SARI ALAN (Senkop & Hipotansiyon)',
              incidentSummary: 'Toplu taşımada ani bayılma, baş dönmesi, geçici bilinç kaybı.',
              vitals: { bp: '95/60 mmHg', pulse: 92, spo2: 97, gcs: 15, bloodSugar: 88, temp: 36.5 },
              etaMinutes: 8,
              status: 'EnRoute',
              encounterId: null,
              bedAssigned: null,
              createdAt: new Date().toISOString(),
              arrivedAt: null
            };
            db.ulakCases.unshift(newCase);
            pushIntegration({
              target: 'ULAK 112 Acil Vaka Ağı', eventType: 'YeniVakaBildirimi',
              aggregateType: 'emergency', aggregateId: newCase.id, payload: newCase
            });
            appendAudit(actor, 'ULAK_AMBULANCE_DISPATCH_INJECTED', 'emergency', newCase.id);
            return sendJson(res, 200, { ok: true, message: 'Yeni 112 ambulans vakası simüle edildi.', item: newCase });
          }
          if (eventType === 'hl7_lab') {
            requireRoles(actor, ['admin', 'lab', 'integration']);
            const newLab = {
              id: ++db.counters.labResult,
              orderId: 8,
              analyteCode: '1988-5',
              display: 'C-Reaktif Protein (CRP)',
              value: '48.5',
              unit: 'mg/L',
              referenceRange: '0 - 5.0',
              flag: 'H',
              criticalFlag: false,
              criticalAckBy: null,
              criticalAckAt: null,
              criticalAckNote: null,
              communicatedWith: null,
              resultedAt: new Date().toISOString()
            };
            db.labResults.unshift(newLab);
            pushIntegration({
              target: 'LIS / HL7 v2 (Cihaz Ağı)', eventType: 'ORU_R01_SonucAlimi',
              aggregateType: 'lab_result', aggregateId: String(newLab.id), payload: newLab
            });
            appendAudit(actor, 'HL7_LAB_RESULT_INJECTED', 'lab_result', newLab.id);
            return sendJson(res, 200, { ok: true, message: 'HL7 ORU^R01 otoanalizör sonucu simüle edildi.', item: enrichLabResult(newLab) });
          }
          return sendJson(res, 400, { error: 'Bilinmeyen simülasyon türü.' });
        }

        return sendJson(res, 404, { error: 'API endpoint bulunamadı.' });
      }

      // 3. Static File Server (Serving `web/` with traversal protection & CSP headers)
      let decodedPath;
      let decodedRawPath;
      try {
        decodedPath = decodeURIComponent(pathname);
        decodedRawPath = decodeURIComponent(rawUrlPath);
      } catch {
        res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      if (decodedPath.includes('\0') || decodedRawPath.includes('\0') || decodedRawPath.split(/[\\/]/).includes('..')) {
        res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Access Denied');
        return;
      }

      const relPath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
      const resolvedPath = path.resolve(WEB_ROOT, relPath);
      if (resolvedPath !== WEB_ROOT && !resolvedPath.startsWith(WEB_ROOT + path.sep)) {
        res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Access Denied');
        return;
      }

      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': getMimeType(resolvedPath)
        });
        fs.createReadStream(resolvedPath).pipe(res);
        return;
      }

      // Never fall back missing .js / .css / asset files to index.html
      if (path.extname(resolvedPath)) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const indexPath = path.join(WEB_ROOT, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8'
        });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.statusCode, { error: err.message, ...(err.extra || {}) });
      }
      console.error('API Error:', err);
      return sendJson(res, 500, { error: err.message || 'Sunucu içi hata' });
    }
  }

  const server = http.createServer(handleRequest);
  return {
    server,
    getDb: () => db,
    resetDb: () => { db = createInitialDataset(); },
    sessions,
    appendAudit
  };
}

if (require.main === module) {
  const configuredPort = process.env.PORT !== undefined ? Number(process.env.PORT) : 8088;
  const app = createApp({ port: configuredPort || 8088 });
  app.server.listen(configuredPort, '0.0.0.0', () => {
    const addr = app.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : configuredPort;
    console.log('================================================================');
    console.log(' NOVA HBYS — Stage 4 Enterprise Parity & Simulation Server');
    console.log(` Server running on http://localhost:${actualPort}`);
    console.log('================================================================');
  });
}

module.exports = {
  createApp,
  ALL_ROLES,
  ROLE_LABELS,
  DEMO_USERS,
  checkOrderTransition,
  computeNews2,
  evaluateCriticalLab,
  matchDrugAllergyConflict,
  parseHl7Oru,
  buildHl7Ack,
  verifyAuditChain,
  roundMoney,
  parsePositiveMoney
};
