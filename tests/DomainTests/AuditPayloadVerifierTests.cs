using Hbys.BuildingBlocks.Audit;
using Xunit;

namespace DomainTests;

public sealed class AuditPayloadVerifierTests
{
    private const string Canonical = """{"previous_hash":"0000000000000000000000000000000000000000000000000000000000000000","occurred_at":"2026-11-05T10:20:30.1234567+00:00","username":"demo","role":"doctor","action":"ORDER_CREATED","entity_type":"order","entity_id":"42","details":{"order_id":42,"critical":false}}""";
    private static readonly DateTime OccurredAt = new DateTime(2026, 11, 5, 10, 20, 30, 123, DateTimeKind.Utc).AddTicks(4560);
    private const string Details = """{"critical":false,"order_id":42}""";

    [Fact]
    public void Matching_columns_and_details_are_accepted()
        => Assert.True(AuditPayloadVerifier.MatchesColumns(Canonical, OccurredAt, "demo", "doctor",
            "ORDER_CREATED", "order", "42", Details));

    [Fact]
    public void Column_only_tampering_is_detected()
        => Assert.False(AuditPayloadVerifier.MatchesColumns(Canonical, OccurredAt, "attacker", "doctor",
            "ORDER_CREATED", "order", "42", Details));

    [Fact]
    public void Details_tampering_is_detected_even_when_hash_input_is_unchanged()
        => Assert.False(AuditPayloadVerifier.MatchesColumns(Canonical, OccurredAt, "demo", "doctor",
            "ORDER_CREATED", "order", "42", """{"critical":true,"order_id":42}"""));

    [Fact]
    public void Timestamp_column_tampering_is_detected()
        => Assert.False(AuditPayloadVerifier.MatchesColumns(Canonical, OccurredAt.AddSeconds(1), "demo", "doctor",
            "ORDER_CREATED", "order", "42", Details));

    [Fact]
    public void Malformed_canonical_payload_is_reported_as_invalid()
        => Assert.False(AuditPayloadVerifier.MatchesColumns("not-json", OccurredAt, "demo", "doctor",
            "ORDER_CREATED", "order", "42", Details));
}
