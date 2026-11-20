using Hbys.BuildingBlocks.Domain;
using Xunit;

namespace DomainTests;

public sealed class OrderStateMachineTests
{
    [Theory]
    [InlineData("Created", "Submitted", "doctor", "LAB", true)]
    [InlineData("Submitted", "InProgress", "lab", "LAB", true)]
    [InlineData("Submitted", "InProgress", "radiology", "RAD", true)]
    [InlineData("Submitted", "InProgress", "doctor", "PROCEDURE", true)]
    [InlineData("Submitted", "InProgress", "doctor", "CONSULT", true)]
    [InlineData("InProgress", "Resulted", "lab", "LAB", true)]
    [InlineData("InProgress", "Resulted", "radiology", "RAD", true)]
    [InlineData("InProgress", "Resulted", "doctor", "PROCEDURE", true)]
    [InlineData("InProgress", "Resulted", "doctor", "CONSULT", true)]
    [InlineData("Resulted", "Verified", "doctor", "LAB", true)]
    [InlineData("Resulted", "Verified", "doctor", "PROCEDURE", true)]
    [InlineData("Resulted", "Verified", "doctor", "CONSULT", true)]
    [InlineData("Submitted", "Cancelled", "doctor", "PROCEDURE", true)]
    [InlineData("InProgress", "Cancelled", "admin", "CONSULT", true)]
    [InlineData("Created", "Verified", "doctor", "LAB", false)]
    [InlineData("Submitted", "InProgress", "nurse", "LAB", false)]
    [InlineData("Submitted", "InProgress", "lab", "RAD", false)]
    [InlineData("Submitted", "InProgress", "lab", "PROCEDURE", false)]
    [InlineData("Submitted", "InProgress", "radiology", "CONSULT", false)]
    [InlineData("Submitted", "InProgress", "radiology", "LAB", false)]
    [InlineData("InProgress", "Resulted", "radiology", "LAB", false)]
    [InlineData("InProgress", "Resulted", "lab", "RAD", false)]
    [InlineData("InProgress", "Resulted", "nurse", "CONSULT", false)]
    [InlineData("Verified", "Cancelled", "admin", "LAB", false)]
    [InlineData("Verified", "Cancelled", "doctor", "PROCEDURE", false)]
    [InlineData("Rejected", "Submitted", "doctor", "LAB", true)]
    [InlineData("Rejected", "Submitted", "nurse", "LAB", false)]
    public void Only_matching_role_and_order_type_transitions_are_accepted(string from, string to, string role, string orderType, bool expected)
        => Assert.Equal(expected, OrderStateMachine.CanTransition(from, to, role, orderType));

    [Theory]
    [InlineData("Submitted", "InProgress", "PROCEDURE", true)]
    [InlineData("InProgress", "Resulted", "CONSULT", true)]
    [InlineData("Verified", "InProgress", "LAB", false)]
    [InlineData("Submitted", "InProgress", "UNKNOWN", false)]
    public void Structural_transition_validates_graph_independently_of_role(string from, string to, string orderType, bool expected)
        => Assert.Equal(expected, OrderStateMachine.IsStructuralTransitionValid(from, to, orderType));
}

public sealed class MoneyRulesTests
{
    [Theory]
    [InlineData(2, 12.345, 24.70)]
    [InlineData(0.5, 100, 50.00)]
    [InlineData(1, 0, 0)]
    public void Line_total_is_rounded_to_two_decimals(decimal quantity, decimal unitPrice, decimal expected)
        => Assert.Equal(expected, MoneyRules.LineTotal(quantity, unitPrice));

    [Fact]
    public void Negative_amount_is_rejected()
        => Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.Normalize(-0.01m));

    [Fact]
    public void Zero_quantity_is_rejected()
        => Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.LineTotal(0, 15m));

    [Fact]
    public void Quantity_below_minimum_is_rejected()
        => Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.LineTotal(0.001m, 15m));

    [Fact]
    public void Quantity_with_more_than_two_decimal_places_is_rejected()
        => Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.LineTotal(1.005m, 15m));

    [Fact]
    public void Multi_line_invoice_calculates_exact_line_totals_and_grand_total()
    {
        var result = MoneyRules.CalculateInvoiceLines(new[]
        {
            new InvoiceLineInput("520.030", "Poliklinik Muayene", 1m, 350.00m),
            new InvoiceLineInput("L101", "Tam Kan Sayımı", 2m, 62.55m),
            new InvoiceLineInput("P200", "Pansuman", 1.50m, 100.01m)
        });

        Assert.Equal(3, result.LineTotals.Count);
        Assert.Equal(350.00m, result.LineTotals[0]);
        Assert.Equal(125.10m, result.LineTotals[1]);
        Assert.Equal(150.02m, result.LineTotals[2]);
        Assert.Equal(625.12m, result.TotalAmount);
    }

    [Fact]
    public void Multi_line_invoice_rejects_empty_lines_and_excess_decimals()
    {
        Assert.Throws<ArgumentException>(() => MoneyRules.CalculateInvoiceLines(Array.Empty<InvoiceLineInput>()));
        Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.CalculateInvoiceLines(new[]
        {
            new InvoiceLineInput("520.030", "Muayene", 1m, 10.123m)
        }));
        Assert.Throws<ArgumentOutOfRangeException>(() => MoneyRules.ValidatePositiveTwoDecimals(0m, "amount"));
    }
}
