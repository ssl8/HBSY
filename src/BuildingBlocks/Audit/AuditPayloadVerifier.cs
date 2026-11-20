using System.Globalization;
using System.Text.Json;

namespace Hbys.BuildingBlocks.Audit;

/// <summary>
/// Verifies that the human-readable audit columns still match the data covered by the hash.
/// This detects column-only tampering even when canonical_payload and event_hash were left intact.
/// </summary>
public static class AuditPayloadVerifier
{
    public static bool MatchesColumns(
        string canonicalPayload,
        DateTime occurredAt,
        string username,
        string role,
        string action,
        string entityType,
        string? entityId,
        string detailsJson)
    {
        try
        {
            using var canonicalDocument = JsonDocument.Parse(canonicalPayload);
            using var detailsDocument = JsonDocument.Parse(detailsJson);
            var root = canonicalDocument.RootElement;

            if (root.ValueKind != JsonValueKind.Object ||
                !MatchesString(root, "username", username) ||
                !MatchesString(root, "role", role) ||
                !MatchesString(root, "action", action) ||
                !MatchesString(root, "entity_type", entityType) ||
                !MatchesNullableString(root, "entity_id", entityId) ||
                !root.TryGetProperty("occurred_at", out var occurredElement) ||
                occurredElement.ValueKind != JsonValueKind.String ||
                !DateTimeOffset.TryParse(occurredElement.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out var payloadOccurredAt) ||
                !SameMicrosecond(payloadOccurredAt.UtcDateTime, DateTime.SpecifyKind(occurredAt, DateTimeKind.Utc)) ||
                !root.TryGetProperty("details", out var payloadDetails))
            {
                return false;
            }

            return JsonEquals(payloadDetails, detailsDocument.RootElement);
        }
        catch (JsonException)
        {
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static bool MatchesString(JsonElement root, string name, string expected) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
        string.Equals(value.GetString(), expected, StringComparison.Ordinal);

    private static bool MatchesNullableString(JsonElement root, string name, string? expected)
    {
        if (!root.TryGetProperty(name, out var value)) return false;
        return expected is null
            ? value.ValueKind == JsonValueKind.Null
            : value.ValueKind == JsonValueKind.String && string.Equals(value.GetString(), expected, StringComparison.Ordinal);
    }

    private static bool SameMicrosecond(DateTime leftUtc, DateTime rightUtc) =>
        leftUtc.Ticks / 10 == rightUtc.Ticks / 10;

    private static bool JsonEquals(JsonElement left, JsonElement right)
    {
        if (left.ValueKind != right.ValueKind) return false;
        switch (left.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var leftProperties = left.EnumerateObject().ToArray();
                var rightProperties = right.EnumerateObject().ToArray();
                if (leftProperties.Length != rightProperties.Length) return false;
                foreach (var property in leftProperties)
                {
                    if (!right.TryGetProperty(property.Name, out var rightValue) || !JsonEquals(property.Value, rightValue))
                        return false;
                }
                return true;
            }
            case JsonValueKind.Array:
            {
                var leftItems = left.EnumerateArray();
                var rightItems = right.EnumerateArray();
                while (leftItems.MoveNext())
                {
                    if (!rightItems.MoveNext() || !JsonEquals(leftItems.Current, rightItems.Current)) return false;
                }
                return !rightItems.MoveNext();
            }
            case JsonValueKind.String:
                return string.Equals(left.GetString(), right.GetString(), StringComparison.Ordinal);
            case JsonValueKind.Number:
                if (left.TryGetDecimal(out var leftDecimal) && right.TryGetDecimal(out var rightDecimal))
                    return leftDecimal == rightDecimal;
                return left.GetDouble().Equals(right.GetDouble());
            case JsonValueKind.True:
            case JsonValueKind.False:
            case JsonValueKind.Null:
                return true;
            default:
                return false;
        }
    }
}
