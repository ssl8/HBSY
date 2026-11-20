/**
 * Centralized client state, canonical 9-role definitions, and RBAC navigation matrix.
 */

export const ROLE_LABELS = {
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

export const DEMO_USERS = [
  { role: 'admin', username: 'admin', displayName: 'Prof. Dr. Başhekim / Admin', icon: '🛡️', sub: 'Tam Yetkili Yönetim' },
  { role: 'doctor', username: 'doctor', displayName: 'Uzm. Dr. Deniz Arslan', icon: '👨‍⚕️', sub: 'Klinik & e-Reçete' },
  { role: 'nurse', username: 'nurse', displayName: 'Hemşire Elif Kaya', icon: '👩‍⚕️', sub: 'Yatış, Vital & Triyaj' },
  { role: 'lab', username: 'lab', displayName: 'Uzm. Caner Öztürk', icon: '🔬', sub: 'LİS & HL7 ORU^R01' },
  { role: 'radiology', username: 'radiology', displayName: 'Dr. Burak Koç', icon: '🩻', sub: 'Radyoloji & DICOM PACS' },
  { role: 'pharmacist', username: 'pharmacist', displayName: 'Ecz. Selin Aydın', icon: '💊', sub: 'Eczane & İTS Karekod' },
  { role: 'billing', username: 'billing', displayName: 'Ayşe Aksoy', icon: '💳', sub: 'SUT Faturalama & MEDULA' },
  { role: 'registrar', username: 'registrar', displayName: 'Mert Yıldırım', icon: '🪪', sub: 'Hasta Kabul & MHRS' },
  { role: 'integration', username: 'integration', displayName: 'Kemal Tan', icon: '⇄', sub: 'Outbox & Dış Sistemler' }
];

export const NAV_ITEMS = [
  ['dashboard', '⌂', 'Genel Bakış', ['admin', 'doctor', 'nurse', 'lab', 'radiology', 'pharmacist', 'billing', 'registrar', 'integration']],
  ['patients', '◉', 'Hasta Yönetimi', ['admin', 'doctor', 'nurse', 'registrar']],
  ['clinical', '✚', 'Klinik & İstemler', ['admin', 'doctor', 'lab', 'radiology']],
  ['beds', '▦', 'Yatış & Yatak', ['admin', 'doctor', 'nurse', 'registrar']],
  ['pharmacy', '⚕', 'Eczane & İTS', ['admin', 'doctor', 'pharmacist', 'nurse']],
  ['billing', '₺', 'Faturalama', ['admin', 'billing', 'registrar']],
  ['vaccinations', '✳', 'Aşı / Halk Sağlığı', ['admin', 'doctor', 'nurse', 'registrar']],
  ['connectors', '⇄', 'Dış Bağlayıcılar', ['admin', 'doctor', 'nurse', 'pharmacist', 'billing', 'registrar', 'integration']],
  ['integrations', '⇌', 'Entegrasyonlar', ['admin', 'integration']],
  ['audit', '⌁', 'Denetim İzleri', ['admin']]
];

export const PAGE_NAMES = {
  ...Object.fromEntries(NAV_ITEMS.map(([id, , name]) => [id, name])),
  mhrs: 'Dış Bağlayıcılar · MHRS',
  ulak: 'Dış Bağlayıcılar · ULAK 112'
};

export const state = {
  config: {
    mode: 'demo',
    auth: 'demo',
    oidc: null,
    features: {
      connectors: true,
      simulation: false,
      patient360: true,
      cdsAllergy: true,
      criticalAck: true,
      vitalsNews2: true,
      dicomViewer: true,
      hl7Sandbox: true
    }
  },
  user: null,
  token: null,
  page: 'dashboard',
  clinicalTab: 'queue',
  connectorTab: 'overview',
  patients: [],
  encounters: [],
  orders: [],
  labResults: [],
  radiologyReports: [],
  lisInbox: [],
  beds: [],
  admissions: [],
  drugs: [],
  prescriptions: [],
  invoices: [],
  vaccinations: [],
  integrations: [],
  connectorsOverview: null,
  mhrsAppointments: [],
  ulakCases: [],
  auditData: null,
  sim: {
    running: false,
    paused: false,
    currentStepIndex: 0,
    currentStep: null,
    history: []
  }
};

export function currentRole() {
  return String(state.user?.role || '').toLowerCase();
}

export function hasRole(...roles) {
  return roles.includes(currentRole());
}

export function canAccessPage(page, role = currentRole()) {
  if (page === 'mhrs' || page === 'ulak') {
    return NAV_ITEMS.some(([id, , , roles]) => id === 'connectors' && roles.includes(role));
  }
  return NAV_ITEMS.some(([id, , , roles]) => id === page && roles.includes(role));
}
