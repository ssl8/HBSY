/**
 * Drug-Allergy Clinical Decision Support (CDS) Conflict Modal.
 * Handles 409 ALLERGY_CONFLICT from POST /api/prescriptions and allows
 * documented clinical override (>= 5 chars) or safe cancellation.
 */

import { api } from '../api.js';
import { $, closeModal, esc, showModal, toast } from '../dom.js';

export function showAllergyConflictModal({ conflict, pendingPayload, onSuccess }) {
  const allergy = conflict?.allergy || 'Bilinmeyen Alerji';
  const drugName = conflict?.drugName || 'Seçili İlaç';
  const msg = conflict?.error || 'Hastada kayıtlı ilaç/madde alerjisi ile çakışma tespit edildi.';

  const body = `
    <form id="allergy-override-form" class="cds-conflict-wrap">
      <div class="cds-alert-box">
        <div class="cds-alert-icon">⚠️</div>
        <div>
          <strong>Klinik Karar Destek Uyarısı (Drug–Allergy CDS)</strong>
          <p>${esc(msg)}</p>
          <div class="cds-conflict-meta">
            <span class="badge red">Alerjen: ${esc(allergy)}</span>
            <span class="badge amber">Çakışan İlaç: ${esc(drugName)}</span>
          </div>
        </div>
      </div>

      <div class="field full">
        <label for="allergy-override-reason">Klinik Geçersiz Kılma Gerekçesi (En az 5 karakter) *</label>
        <textarea
          id="allergy-override-reason"
          name="overrideReason"
          minlength="5"
          maxlength="500"
          required
          placeholder="Örn. Hasta daha önce tolere etti, alternatif antibiyotik kontrendike; yakın gözlem altında uygulanacak."
        ></textarea>
      </div>
      <div id="allergy-override-error" class="form-error" role="alert"></div>

      <div class="notice">
        Onaylandığında bu karar denetim izine <strong>ALLERGY_OVERRIDE</strong> olayı olarak kaydedilecektir.
      </div>

      <div class="form-actions">
        <button class="btn btn-ghost" type="button" id="btn-abort-allergy">Vazgeç / İlacı Değiştir</button>
        <button class="btn btn-danger" type="submit">Klinik Sorumlulukla Onayla (Override)</button>
      </div>
    </form>
  `;

  showModal('Alerji Çakışması Tespit Edildi (409 CDS)', body, 'KLİNİK GÜVENLİK UYARISI');

  const form = $('#allergy-override-form');
  const errEl = $('#allergy-override-error');
  const abortBtn = $('#btn-abort-allergy');

  abortBtn?.addEventListener('click', () => closeModal());

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const reason = String($('#allergy-override-reason')?.value || '').trim();
    if (reason.length < 5) {
      if (errEl) errEl.textContent = 'Klinik gerekçe en az 5 karakter olmalıdır.';
      return;
    }
    if (errEl) errEl.textContent = '';

    try {
      await api('/api/prescriptions', {
        method: 'POST',
        body: {
          ...pendingPayload,
          overrideAllergy: true,
          overrideReason: reason
        }
      });
      toast('e-Reçete klinik alerji override gerekçesi ile kaydedildi (ALLERGY_OVERRIDE).', 'success');
      closeModal();
      if (typeof onSuccess === 'function') await onSuccess();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Override işlemi tamamlanamadı.';
      toast(err.message, 'error');
    }
  });
}
