using Hbys.BuildingBlocks.Domain;
using Xunit;

namespace DomainTests;

public sealed class News2AndCdsTests
{
    [Fact]
    public void Normal_vitals_produce_zero_low_risk()
    {
        var result = News2Calculator.Calculate(
            systolicBp: 120,
            diastolicBp: 80,
            heartRate: 76,
            respRate: 16,
            tempC: 36.7m,
            spo2: 98,
            consciousness: 'A');

        Assert.Equal(0, result.Score);
        Assert.Equal("LOW", result.Risk);
        Assert.False(result.HasSingleExtremeScore);
    }

    [Fact]
    public void Single_extreme_parameter_triggers_low_medium_risk()
    {
        // Only SpO2 = 90 scores 3; total score = 3
        var result = News2Calculator.Calculate(
            systolicBp: 120,
            diastolicBp: 78,
            heartRate: 75,
            respRate: 16,
            tempC: 36.8m,
            spo2: 90,
            consciousness: 'A');

        Assert.Equal(3, result.Score);
        Assert.Equal("LOW_MEDIUM", result.Risk);
        Assert.True(result.HasSingleExtremeScore);
    }

    [Fact]
    public void Deteriorating_emergency_patient_computes_exact_high_news2_score()
    {
        // RR 26 (+3), SpO2 89 (+3), Temp 36.7 (0), SBP 85 (+3), HR 122 (+2), AVPU 'A' (0) => 11 HIGH
        var result = News2Calculator.Calculate(85, 55, 122, 26, 36.7m, 89, 'A');

        Assert.Equal(11, result.Score);
        Assert.Equal("HIGH", result.Risk);
        Assert.True(result.HasSingleExtremeScore);
    }

    [Fact]
    public void Invalid_vitals_or_avpu_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => News2Calculator.Calculate(20, 80, 75, 16, 36.6m, 98, 'A'));
        Assert.Throws<ArgumentException>(() => News2Calculator.Calculate(120, 80, 75, 16, 36.6m, 98, 'X'));
    }

    [Fact]
    public void Allergy_matcher_detects_cross_reactivity_and_ignores_negations()
    {
        var amoxicillin = new DrugAllergyCandidate(2, "Amoksisilin 1000 mg", "Amoksisilin", "Penicillin");
        var aspirin = new DrugAllergyCandidate(8, "Coraspin 100 mg", "Asetilsalisilik Asit", "NSAID");
        var saline = new DrugAllergyCandidate(3, "Izotonik %0.9", "Sodyum Klorür", null);

        var conflict = AllergyMatcher.FindConflict("Penisilin", new[] { saline, amoxicillin });
        Assert.NotNull(conflict);
        Assert.Equal(2, conflict!.DrugId);
        Assert.Equal("Penisilin", conflict.MatchedAllergy);

        var nsaidConflict = AllergyMatcher.FindConflict("Aspirin", new[] { saline, aspirin });
        Assert.NotNull(nsaidConflict);
        Assert.Equal(8, nsaidConflict!.DrugId);

        Assert.Null(AllergyMatcher.FindConflict("Yok", new[] { amoxicillin, aspirin }));
        Assert.Null(AllergyMatcher.FindConflict("Sulfa grubu", new[] { saline, aspirin }));
    }

    [Theory]
    [InlineData("10839-9", "Kardiyak Troponin I", "1.92", "HH", false, true)]
    [InlineData("10839-9", "Kardiyak Troponin I", "0.02", "N", false, false)]
    [InlineData("2823-3", "Potasyum (K+)", "6.1", "H", false, true)]
    [InlineData("2823-3", "Potasyum (K+)", "2.7", "L", false, true)]
    [InlineData("2345-7", "Glukoz", "415", "H", false, true)]
    [InlineData("718-7", "Hemoglobin", "6.8", "L", false, true)]
    [InlineData("4548-4", "HbA1c (Glikozile Hemoglobin)", "8.9", "H", false, false)]
    public void Critical_lab_evaluator_identifies_panic_thresholds_without_hba1c_false_positives(
        string code, string display, string value, string flag, bool explicitCritical, bool expected)
        => Assert.Equal(expected, CriticalLabEvaluator.IsCritical(code, display, value, flag, explicitCritical));
}
