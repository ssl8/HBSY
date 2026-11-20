using System.Globalization;
using System.Text;

namespace Hbys.BuildingBlocks.Domain;

public sealed record DrugAllergyCandidate(long DrugId, string Name, string? GenericName, string? AllergyGroup);
public sealed record AllergyConflict(long DrugId, string DrugName, string MatchedAllergy);

/// <summary>
/// Clinical decision support matcher for patient allergies vs prescribed drugs.
/// </summary>
public static class AllergyMatcher
{
    private static readonly HashSet<string> Negations = new(StringComparer.Ordinal)
    {
        "yok", "none", "hayir", "bilinmiyor", "nka", "nkda", "-"
    };

    private static readonly (string[] AllergyTokens, string[] DrugTokens)[] CrossReactivityRules =
    [
        (["penisilin", "penicillin", "amoksisilin", "amoxicillin", "ampisilin", "ampicillin"],
         ["penisilin", "penicillin", "amoksisilin", "amoxicillin", "ampisilin", "ampicillin"]),
        (["beta-laktam", "beta-lactam", "betalaktam", "betalactam"],
         ["beta-laktam", "beta-lactam", "penisilin", "penicillin", "amoksisilin", "seftriakson", "ceftriaxone", "sefalosporin", "cephalosporin"]),
        (["aspirin", "nsaid", "asetilsalisilik", "salisilat", "ibuprofen", "diklofenak", "naproksen"],
         ["aspirin", "nsaid", "asetilsalisilik", "acetylsalicylic", "salisilat", "ibuprofen", "diklofenak", "naproksen"]),
        (["sulfa", "sulfonamid", "sulfonamide", "sulfa grubu"],
         ["sulfa", "sulfonamid", "sulfonamide", "kotrimoksazol", "sulfametoksazol"]),
        (["heparin", "enoksaparin"],
         ["heparin", "enoksaparin", "enoxaparin"]),
        (["parasetamol", "asetaminofen", "acetaminophen"],
         ["parasetamol", "paracetamol", "asetaminofen", "acetaminophen"])
    ];

    public static AllergyConflict? FindConflict(string? patientAllergies, IEnumerable<DrugAllergyCandidate> drugs)
    {
        if (string.IsNullOrWhiteSpace(patientAllergies)) return null;

        var rawTokens = patientAllergies
            .Split([',', ';', '|', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        foreach (var rawToken in rawTokens)
        {
            var normalizedAllergy = Fold(rawToken);
            if (normalizedAllergy.Length < 3 || Negations.Contains(normalizedAllergy)) continue;

            foreach (var drug in drugs)
            {
                var drugCorpus = $"{Fold(drug.Name)} {Fold(drug.GenericName)} {Fold(drug.AllergyGroup)}";
                if (string.IsNullOrWhiteSpace(drugCorpus)) continue;

                if (drugCorpus.Contains(normalizedAllergy, StringComparison.Ordinal))
                    return new AllergyConflict(drug.DrugId, drug.Name, rawToken);

                foreach (var (allergyKeys, drugKeys) in CrossReactivityRules)
                {
                    var allergyMatchesRule = allergyKeys.Any(k => normalizedAllergy.Contains(k, StringComparison.Ordinal) || k.Contains(normalizedAllergy, StringComparison.Ordinal));
                    if (!allergyMatchesRule) continue;
                    if (drugKeys.Any(k => drugCorpus.Contains(k, StringComparison.Ordinal)))
                        return new AllergyConflict(drug.DrugId, drug.Name, rawToken);
                }
            }
        }

        return null;
    }

    private static string Fold(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return "";
        var sb = new StringBuilder(input.Length);
        foreach (var ch in input.Trim())
        {
            sb.Append(ch switch
            {
                'İ' or 'I' or 'ı' => 'i',
                'Ş' or 'ş' => 's',
                'Ğ' or 'ğ' => 'g',
                'Ü' or 'ü' => 'u',
                'Ö' or 'ö' => 'o',
                'Ç' or 'ç' => 'c',
                _ => char.ToLowerInvariant(ch)
            });
        }
        return sb.ToString();
    }
}
