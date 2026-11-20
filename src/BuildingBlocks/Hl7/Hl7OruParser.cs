namespace Hbys.BuildingBlocks.Hl7;

public sealed record Hl7Observation(string Code, string Display, string Value, string? Unit, string? ReferenceRange, string Flag, bool Critical);
public sealed record Hl7OruMessage(
    string MessageControlId,
    string PatientIdentifier,
    string OrderIdentifier,
    string TestCode,
    string TestDisplay,
    IReadOnlyList<Hl7Observation> Observations,
    string SendingApplication = "",
    string MessageTimestamp = "");

public static class Hl7OruParser
{
    public static Hl7OruMessage Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) throw new ArgumentException("HL7 mesajı boş olamaz.");
        if (raw.Length > 1_000_000) throw new ArgumentException("HL7 mesajı 1 MB sınırını aşıyor.");
        var normalized = raw.Replace("\u000b", "", StringComparison.Ordinal).Replace("\u001c", "", StringComparison.Ordinal);
        var segments = normalized.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
        var msh = segments.FirstOrDefault(x => x.StartsWith("MSH", StringComparison.Ordinal))
            ?? throw new ArgumentException("HL7 MSH segmenti bulunamadı.");
        if (msh.Length < 4) throw new ArgumentException("HL7 MSH segmenti bozuk.");
        var separator = msh[3];
        var fields = msh.Split(separator);
        var sendingApp = (fields.ElementAtOrDefault(2) ?? "").Trim();
        var messageTimestamp = (fields.ElementAtOrDefault(6) ?? "").Trim();
        var messageType = fields.ElementAtOrDefault(8) ?? "";
        if (!messageType.StartsWith("ORU^R01", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Yalnızca HL7 ORU^R01 mesajları kabul edilir.");
        var controlId = Required(fields.ElementAtOrDefault(9), "MSH-10 mesaj kontrol numarası", 100);
        var pid = segments.FirstOrDefault(x => x.StartsWith("PID" + separator, StringComparison.Ordinal))
            ?? throw new ArgumentException("HL7 PID segmenti bulunamadı.");
        var obr = segments.FirstOrDefault(x => x.StartsWith("OBR" + separator, StringComparison.Ordinal))
            ?? throw new ArgumentException("HL7 OBR segmenti bulunamadı.");
        var pidFields = pid.Split(separator);
        var obrFields = obr.Split(separator);
        var patientId = FirstComponent(pidFields.ElementAtOrDefault(3));
        if (patientId.Length > 32) throw new ArgumentException("PID-3 hasta numarası en fazla 32 karakter olabilir.");
        var orderId = FirstComponent(obrFields.ElementAtOrDefault(3));
        var testParts = Components(obrFields.ElementAtOrDefault(4));
        var testCode = Required(testParts.ElementAtOrDefault(0), "OBR-4 test kodu", 80);
        var testDisplay = testParts.ElementAtOrDefault(1) ?? testCode;
        if (string.IsNullOrWhiteSpace(patientId)) throw new ArgumentException("PID-3 hasta numarası bulunamadı.");
        if (string.IsNullOrWhiteSpace(orderId)) throw new ArgumentException("OBR-3 istem numarası bulunamadı.");

        var observations = new List<Hl7Observation>();
        foreach (var segment in segments.Where(x => x.StartsWith("OBX" + separator, StringComparison.Ordinal)))
        {
            var f = segment.Split(separator);
            var test = Components(f.ElementAtOrDefault(3));
            var code = Required(test.ElementAtOrDefault(0), "OBX-3 analit kodu", 80);
            var display = test.ElementAtOrDefault(1) ?? code;
            if (display.Length > 120) throw new ArgumentException("OBX-3 analit adı en fazla 120 karakter olabilir.");
            var value = Required(f.ElementAtOrDefault(5), "OBX-5 sonuç değeri", 120);
            var unit = FirstComponent(f.ElementAtOrDefault(6));
            if (unit.Length > 30) throw new ArgumentException("OBX-6 birim en fazla 30 karakter olabilir.");
            var range = f.ElementAtOrDefault(7);
            if (range is { Length: > 60 }) throw new ArgumentException("OBX-7 referans aralığı en fazla 60 karakter olabilir.");
            var rawFlag = (f.ElementAtOrDefault(8) ?? "N").Trim().ToUpperInvariant();
            var critical = rawFlag is "HH" or "LL" or "AA";
            var flag = rawFlag switch { "HH" or "AA" => "HH", "LL" => "LL", "H" => "H", "L" => "L", _ => "N" };
            observations.Add(new Hl7Observation(code, display, value, unit, string.IsNullOrWhiteSpace(range) ? null : range, flag, critical));
        }
        if (observations.Count == 0) throw new ArgumentException("ORU mesajında en az bir OBX sonucu bulunmalıdır.");
        if (observations.Count > 1000) throw new ArgumentException("Bir HL7 ORU mesajında en fazla 1000 OBX sonucu kabul edilir.");
        return new Hl7OruMessage(controlId, patientId, orderId, testCode, testDisplay, observations, sendingApp, messageTimestamp);
    }

    public static string BuildAck(string messageControlId, string ackCode, string? error = null)
    {
        if (ackCode is not ("AA" or "AE" or "AR")) throw new ArgumentException("Geçersiz HL7 ACK kodu.");
        var escapedId = messageControlId.Replace("|", "\\F\\", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal);
        var ack = $"MSH|^~\\&|NOVA-HBYS|HOSPITAL|LAB-SYSTEM|LAB|{DateTime.UtcNow:yyyyMMddHHmmss}||ACK^R01|ACK-{Guid.NewGuid():N}|P|2.5.1\rMSA|{ackCode}|{escapedId}";
        if (!string.IsNullOrWhiteSpace(error)) ack += "|" + error.Replace("|", "\\F\\", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal);
        return ack + "\r";
    }

    private static string Required(string? value, string label, int maxLength)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0) throw new ArgumentException($"{label} zorunludur.");
        if (text.Length > maxLength) throw new ArgumentException($"{label} en fazla {maxLength} karakter olabilir.");
        return text;
    }

    private static string FirstComponent(string? value) => Components(value).FirstOrDefault() ?? "";
    private static string[] Components(string? value) => (value ?? "").Split('^', StringSplitOptions.TrimEntries);
}
