namespace Hbys.BuildingBlocks.Domain;

public sealed record InvoiceLineInput(string Code, string Description, decimal Quantity, decimal UnitPrice);
public sealed record InvoiceCalculationResult(IReadOnlyList<decimal> LineTotals, decimal TotalAmount);

/// <summary>Role- and order-type-aware state transitions for clinical work queues.</summary>
public static class OrderStateMachine
{
    private static readonly IReadOnlyDictionary<string, string[]> Allowed = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["Created"] = ["Submitted", "Cancelled"],
        ["Submitted"] = ["InProgress", "Cancelled", "Rejected"],
        ["InProgress"] = ["Resulted", "Cancelled"],
        ["Resulted"] = ["Verified"],
        ["Rejected"] = ["Submitted"],
        ["Verified"] = [],
        ["Cancelled"] = []
    };

    private static readonly HashSet<string> SupportedOrderTypes = new(StringComparer.Ordinal)
    {
        "LAB", "RAD", "PROCEDURE", "CONSULT", "DRUG"
    };

    public static bool IsStructuralTransitionValid(string from, string to, string orderType)
    {
        if (string.IsNullOrWhiteSpace(orderType)) return false;
        var type = orderType.Trim().ToUpperInvariant();
        if (!SupportedOrderTypes.Contains(type)) return false;
        return Allowed.TryGetValue(from, out var targets) && targets.Contains(to, StringComparer.Ordinal);
    }

    public static bool CanTransition(string from, string to, string role, string orderType)
    {
        if (!IsStructuralTransitionValid(from, to, orderType)) return false;
        var type = orderType.Trim().ToUpperInvariant();
        var normalizedRole = (role ?? "").Trim().ToLowerInvariant();
        var isExecutorForType =
            (normalizedRole == "lab" && type == "LAB") ||
            (normalizedRole == "radiology" && type == "RAD") ||
            (normalizedRole == "doctor" && type is "PROCEDURE" or "CONSULT" or "DRUG");

        return to switch
        {
            "Submitted" => normalizedRole is "doctor" or "admin",
            "InProgress" => isExecutorForType || normalizedRole == "admin",
            "Resulted" => isExecutorForType || normalizedRole == "admin",
            "Verified" => normalizedRole is "doctor" or "admin",
            "Cancelled" => normalizedRole is "doctor" or "admin",
            "Rejected" => isExecutorForType || normalizedRole == "admin",
            _ => false
        };
    }
}

public static class MoneyRules
{
    public static decimal Normalize(decimal amount)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(nameof(amount), "Tutar negatif olamaz.");
        return decimal.Round(amount, 2, MidpointRounding.AwayFromZero);
    }

    public static decimal LineTotal(decimal quantity, decimal unitPrice)
    {
        if (quantity < 0.01m) throw new ArgumentOutOfRangeException(nameof(quantity), "Miktar en az 0,01 olmalıdır.");
        if (decimal.Round(quantity, 2, MidpointRounding.AwayFromZero) != quantity)
            throw new ArgumentOutOfRangeException(nameof(quantity), "Miktar en fazla iki ondalık basamak içerebilir.");
        return Normalize(quantity * Normalize(unitPrice));
    }

    public static decimal ValidatePositiveTwoDecimals(decimal value, string fieldName)
    {
        if (value <= 0)
            throw new ArgumentOutOfRangeException(fieldName, $"{fieldName} sıfırdan büyük olmalıdır.");
        if (decimal.Round(value, 2, MidpointRounding.AwayFromZero) != value)
            throw new ArgumentOutOfRangeException(fieldName, $"{fieldName} en fazla iki ondalık basamak içerebilir.");
        return value;
    }

    public static InvoiceCalculationResult CalculateInvoiceLines(IReadOnlyList<InvoiceLineInput> lines)
    {
        if (lines is null || lines.Count == 0)
            throw new ArgumentException("En az bir fatura kalemi girilmelidir.");

        var lineTotals = new List<decimal>(lines.Count);
        decimal total = 0m;
        foreach (var line in lines)
        {
            var qty = ValidatePositiveTwoDecimals(line.Quantity, nameof(line.Quantity));
            var price = ValidatePositiveTwoDecimals(line.UnitPrice, nameof(line.UnitPrice));
            if (qty > 100000m) throw new ArgumentOutOfRangeException(nameof(line.Quantity), "Miktar 100000 değerini aşamaz.");
            if (price > 9_999_999.99m) throw new ArgumentOutOfRangeException(nameof(line.UnitPrice), "Birim fiyat üst sınırı aşıldı.");
            var lt = decimal.Round(qty * price, 2, MidpointRounding.AwayFromZero);
            lineTotals.Add(lt);
            total = decimal.Round(total + lt, 2, MidpointRounding.AwayFromZero);
        }

        if (total > 999_999_999_999.99m)
            throw new ArgumentOutOfRangeException(nameof(lines), "Fatura toplamı veri tabanı üst sınırını aşıyor.");

        return new InvoiceCalculationResult(lineTotals, total);
    }
}
