/**
 * Deterministic Royal College of Physicians NEWS2 clinical risk calculator.
 * Matches UNIFIED-CONTRACT.md section 3.5.
 */

export function scoreRespRate(rr) {
  const v = Number(rr);
  if (!Number.isFinite(v)) return 0;
  if (v <= 8) return 3;
  if (v <= 11) return 1;
  if (v <= 20) return 0;
  if (v <= 24) return 2;
  return 3;
}

export function scoreSpo2(spo2) {
  const v = Number(spo2);
  if (!Number.isFinite(v)) return 0;
  if (v <= 91) return 3;
  if (v <= 93) return 2;
  if (v <= 95) return 1;
  return 0;
}

export function scoreTempC(tempC) {
  const v = Number(tempC);
  if (!Number.isFinite(v)) return 0;
  if (v <= 35.0) return 3;
  if (v <= 36.0) return 1;
  if (v <= 38.0) return 0;
  if (v <= 39.0) return 1;
  return 2;
}

export function scoreSystolicBp(sbp) {
  const v = Number(sbp);
  if (!Number.isFinite(v)) return 0;
  if (v <= 90) return 3;
  if (v <= 100) return 2;
  if (v <= 110) return 1;
  if (v <= 219) return 0;
  return 3;
}

export function scoreHeartRate(hr) {
  const v = Number(hr);
  if (!Number.isFinite(v)) return 0;
  if (v <= 40) return 3;
  if (v <= 50) return 1;
  if (v <= 90) return 0;
  if (v <= 110) return 1;
  if (v <= 130) return 2;
  return 3;
}

export function scoreConsciousness(avpu) {
  return String(avpu || 'A').toUpperCase() === 'A' ? 0 : 3;
}

export function computeNews2({ respRate, spo2, tempC, systolicBp, heartRate, consciousness }) {
  const breakdown = {
    respRate: scoreRespRate(respRate),
    spo2: scoreSpo2(spo2),
    tempC: scoreTempC(tempC),
    systolicBp: scoreSystolicBp(systolicBp),
    heartRate: scoreHeartRate(heartRate),
    consciousness: scoreConsciousness(consciousness)
  };
  const parts = Object.values(breakdown);
  const score = parts.reduce((sum, x) => sum + x, 0);
  const hasRedScore = parts.some(x => x === 3);

  let risk = 'LOW';
  if (score >= 7) risk = 'HIGH';
  else if (score >= 5) risk = 'MEDIUM';
  else if (hasRedScore) risk = 'LOW_MEDIUM';

  return { score, risk, breakdown };
}
