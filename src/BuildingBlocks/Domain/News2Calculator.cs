namespace Hbys.BuildingBlocks.Domain;

public sealed record News2Result(int Score, string Risk, bool HasSingleExtremeScore);

/// <summary>
/// Deterministic Royal College of Physicians NEWS2 clinical deterioration score calculator.
/// </summary>
public static class News2Calculator
{
    public static News2Result Calculate(
        int systolicBp,
        int diastolicBp,
        int heartRate,
        int respRate,
        decimal tempC,
        int spo2,
        char consciousness)
    {
        if (systolicBp is < 30 or > 320)
            throw new ArgumentOutOfRangeException(nameof(systolicBp), "Sistolik kan basıncı 30-320 mmHg arasında olmalıdır.");
        if (diastolicBp is < 20 or > 220)
            throw new ArgumentOutOfRangeException(nameof(diastolicBp), "Diyastolik kan basıncı 20-220 mmHg arasında olmalıdır.");
        if (heartRate is < 15 or > 280)
            throw new ArgumentOutOfRangeException(nameof(heartRate), "Nabız 15-280 /dk arasında olmalıdır.");
        if (respRate is < 2 or > 80)
            throw new ArgumentOutOfRangeException(nameof(respRate), "Solunum sayısı 2-80 /dk arasında olmalıdır.");
        if (tempC is < 25.0m or > 45.0m)
            throw new ArgumentOutOfRangeException(nameof(tempC), "Vücut ısısı 25.0-45.0 °C arasında olmalıdır.");
        if (spo2 is < 30 or > 100)
            throw new ArgumentOutOfRangeException(nameof(spo2), "SpO2 %30-%100 arasında olmalıdır.");

        var normalizedAvpu = char.ToUpperInvariant(consciousness);
        if (normalizedAvpu is not ('A' or 'V' or 'P' or 'U'))
            throw new ArgumentException("Bilinç durumu (AVPU) A, V, P veya U olmalıdır.", nameof(consciousness));

        var rrScore = respRate switch
        {
            <= 8 => 3,
            <= 11 => 1,
            <= 20 => 0,
            <= 24 => 2,
            _ => 3
        };

        var spo2Score = spo2 switch
        {
            <= 91 => 3,
            <= 93 => 2,
            <= 95 => 1,
            _ => 0
        };

        var tempScore = tempC switch
        {
            <= 35.0m => 3,
            <= 36.0m => 1,
            <= 38.0m => 0,
            <= 39.0m => 1,
            _ => 2
        };

        var bpScore = systolicBp switch
        {
            <= 90 => 3,
            <= 100 => 2,
            <= 110 => 1,
            <= 219 => 0,
            _ => 3
        };

        var hrScore = heartRate switch
        {
            <= 40 => 3,
            <= 50 => 1,
            <= 90 => 0,
            <= 110 => 1,
            <= 130 => 2,
            _ => 3
        };

        var avpuScore = normalizedAvpu == 'A' ? 0 : 3;

        var total = rrScore + spo2Score + tempScore + bpScore + hrScore + avpuScore;
        var hasExtreme = rrScore == 3 || spo2Score == 3 || tempScore == 3 || bpScore == 3 || hrScore == 3 || avpuScore == 3;

        var risk = total >= 7
            ? "HIGH"
            : total >= 5
                ? "MEDIUM"
                : hasExtreme
                    ? "LOW_MEDIUM"
                    : "LOW";

        return new News2Result(total, risk, hasExtreme);
    }
}
