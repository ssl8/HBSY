using Hbys.BuildingBlocks.Hl7;
using Xunit;

namespace DomainTests;

public sealed class Hl7OruParserTests
{
    private const string ValidOru = """
        MSH|^~\&|LAB-DEMO|HOSPITAL|NOVA|HOSPITAL|20261104123000||ORU^R01|CTRL-100|P|2.5.1
        PID|||HB-000101||
        OBR|||1|718-7^Hemoglobin
        OBX|1|NM|718-7^Hemoglobin||13.5|g/dL|12.0-16.0|N
        OBX|2|NM|789-8^Hematocrit||40.1|%|36.0-46.0|N
        """;

    [Fact]
    public void Parses_oru_patient_order_metadata_and_multiple_results()
    {
        var message = Hl7OruParser.Parse(ValidOru);

        Assert.Equal("CTRL-100", message.MessageControlId);
        Assert.Equal("HB-000101", message.PatientIdentifier);
        Assert.Equal("1", message.OrderIdentifier);
        Assert.Equal("718-7", message.TestCode);
        Assert.Equal("LAB-DEMO", message.SendingApplication);
        Assert.Equal("20261104123000", message.MessageTimestamp);
        Assert.Equal(2, message.Observations.Count);
        Assert.Equal("13.5", message.Observations[0].Value);
        Assert.Equal("g/dL", message.Observations[0].Unit);
    }

    [Fact]
    public void Acknowledgement_contains_application_accept_code()
    {
        var ack = Hl7OruParser.BuildAck("CTRL-100", "AA");
        Assert.Contains("MSA|AA|CTRL-100", ack, StringComparison.Ordinal);
        Assert.StartsWith("MSH|^~\\&|NOVA-HBYS", ack, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_non_oru_message_type()
    {
        var invalid = ValidOru.Replace("ORU^R01", "ADT^A01", StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse(invalid));
    }

    [Fact]
    public void Rejects_missing_observation_segment()
    {
        var invalid = ValidOru[..ValidOru.IndexOf("OBX|", StringComparison.Ordinal)];
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse(invalid));
    }

    [Fact]
    public void Rejects_missing_msh_pid_empty_control_id_and_blank_payload()
    {
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse(""));
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse("PID|||HB-000101||"));

        var noPid = ValidOru.Replace("PID|||HB-000101||\n", "", StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse(noPid));

        var emptyControlId = ValidOru.Replace("|CTRL-100|", "||", StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Hl7OruParser.Parse(emptyControlId));
    }
}
