using System.Globalization;

namespace Hbys.BuildingBlocks.Domain;

/// <summary>
/// Evaluates panic/critical lab values according to UNIFIED-CONTRACT §3.4.
/// </summary>
public static class CriticalLabEvaluator
{
    public static bool IsCritical(string analyteCode, string? display, string value, string flag, bool explicitCritical = false)
    {
        if (explicitCritical) return true;
        var normalizedFlag = (flag ?? "").Trim().ToUpperInvariant();
        if (normalizedFlag is "HH" or "LL") return true;

        if (!TryParseNumeric(value, out var numericValue))
            return false;

        var code = (analyteCode ?? "").Trim().ToUpperInvariant();
        var label = (display ?? "").Trim().ToLowerInvariant();

        // Troponin > 0.04 ng/mL
        if (code is "10839-9" or "6598-7" || label.Contains("troponin", StringComparison.Ordinal))
            return numericValue > 0.04m;

        // Potassium K+ >= 6.0 or <= 2.8 mmol/L
        if (code is "2823-3" or "6298-4" || label.Contains("potasyum", StringComparison.Ordinal) || label.Contains("potassium", StringComparison.Ordinal) || label == "k+")
            return numericValue >= 6.0m || numericValue <= 2.8m;

        // Glucose >= 400 or <= 45 mg/dL
        if (code is "2345-7" or "2339-0" || label.Contains("glukoz", StringComparison.Ordinal) || label.Contains("glucose", StringComparison.Ordinal) || label.Contains("kan şekeri", StringComparison.Ordinal))
            return numericValue >= 400m || numericValue <= 45m;

        // Hemoglobin <= 7.0 g/dL (exclude HbA1c)
        if ((code == "718-7" || label.Contains("hemoglobin", StringComparison.Ordinal) || label.Contains("hgb", StringComparison.Ordinal))
            && code != "4548-4" && !label.Contains("a1c", StringComparison.Ordinal) && !label.Contains("glike", StringComparison.Ordinal))
            return numericValue <= 7.0m;

        return false;
    }

    private static bool TryParseNumeric(string? raw, out decimal result)
    {
        result = 0m;
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var cleaned = raw.Trim().Replace(',', '.');
        return decimal.TryParse(cleaned, NumberStyles.Number, CultureInfo.InvariantCulture, out result);
    }
}
