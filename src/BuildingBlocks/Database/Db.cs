using System.Globalization;
using System.Text;
using Npgsql;
using NpgsqlTypes;

namespace Hbys.BuildingBlocks.Database;

public static class Db
{
    private sealed record TypedValue(NpgsqlDbType Type, object Value);

    public static object TextOrDbNull(string? value) =>
        value is null ? new TypedValue(NpgsqlDbType.Varchar, DBNull.Value) : value;

    public static object BigintOrDbNull(long? value) =>
        value.HasValue ? value.Value : new TypedValue(NpgsqlDbType.Bigint, DBNull.Value);

    public static object IntOrDbNull(int? value) =>
        value.HasValue ? value.Value : new TypedValue(NpgsqlDbType.Integer, DBNull.Value);

    public static object DecimalOrDbNull(decimal? value) =>
        value.HasValue ? value.Value : new TypedValue(NpgsqlDbType.Numeric, DBNull.Value);

    public static object BoolOrDbNull(bool? value) =>
        value.HasValue ? value.Value : new TypedValue(NpgsqlDbType.Boolean, DBNull.Value);

    public static NpgsqlCommand Command(NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql, params object?[] values)
    {
        var command = new NpgsqlCommand(sql, connection, transaction);
        for (var i = 0; i < values.Length; i++)
        {
            if (values[i] is TypedValue typed)
                command.Parameters.Add(new NpgsqlParameter($"p{i}", typed.Type) { Value = typed.Value });
            else if (values[i] is null or DBNull)
                throw new ArgumentException($"SQL parametresi p{i} null olamaz; Db.TextOrDbNull / Db.BigintOrDbNull kullanın.", nameof(values));
            else
                command.Parameters.AddWithValue($"p{i}", values[i]!);
        }
        return command;
    }

    public static async Task<List<Dictionary<string, object?>>> QueryAsync(
        NpgsqlDataSource source, string sql, CancellationToken ct, params object?[] values)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        return await QueryAsync(connection, null, sql, ct, values);
    }

    public static async Task<List<Dictionary<string, object?>>> QueryAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql,
        CancellationToken ct, params object?[] values)
    {
        await using var command = Command(connection, transaction, sql, values);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync(ct))
        {
            var row = new Dictionary<string, object?>(StringComparer.Ordinal);
            for (var i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = await reader.IsDBNullAsync(i, ct) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    public static async Task<List<Dictionary<string, object?>>> QueryCamelAsync(
        NpgsqlDataSource source, string sql, CancellationToken ct, params object?[] values)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        return await QueryCamelAsync(connection, null, sql, ct, values);
    }

    public static async Task<List<Dictionary<string, object?>>> QueryCamelAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql,
        CancellationToken ct, params object?[] values)
    {
        await using var command = Command(connection, transaction, sql, values);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var names = new string[reader.FieldCount];
        for (var i = 0; i < reader.FieldCount; i++)
            names[i] = SnakeToCamel(reader.GetName(i));

        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync(ct))
        {
            var row = new Dictionary<string, object?>(StringComparer.Ordinal);
            for (var i = 0; i < reader.FieldCount; i++)
                row[names[i]] = await reader.IsDBNullAsync(i, ct) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    public static Dictionary<string, object?> ToCamelRow(IReadOnlyDictionary<string, object?> row)
    {
        var result = new Dictionary<string, object?>(row.Count, StringComparer.Ordinal);
        foreach (var kv in row)
            result[SnakeToCamel(kv.Key)] = kv.Value;
        return result;
    }

    public static List<Dictionary<string, object?>> ToCamelRows(IEnumerable<Dictionary<string, object?>> rows) =>
        rows.Select(r => ToCamelRow(r)).ToList();

    public static string SnakeToCamel(string key)
    {
        if (string.IsNullOrEmpty(key)) return key;
        if (!key.Contains('_', StringComparison.Ordinal))
            return char.IsUpper(key[0]) ? char.ToLowerInvariant(key[0]) + key[1..] : key;

        var parts = key.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return key;
        var sb = new StringBuilder(key.Length);
        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            if (i == 0)
                sb.Append(char.ToLowerInvariant(part[0])).Append(part.AsSpan(1));
            else
                sb.Append(char.ToUpperInvariant(part[0])).Append(part.AsSpan(1));
        }
        return sb.ToString();
    }

    public static async Task<int> ExecuteAsync(
        NpgsqlDataSource source, string sql, CancellationToken ct, params object?[] values)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        return await ExecuteAsync(connection, null, sql, ct, values);
    }

    public static async Task<int> ExecuteAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql,
        CancellationToken ct, params object?[] values)
    {
        await using var command = Command(connection, transaction, sql, values);
        return await command.ExecuteNonQueryAsync(ct);
    }

    public static async Task<long> ScalarLongAsync(
        NpgsqlDataSource source, string sql, CancellationToken ct, params object?[] values)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        return await ScalarLongAsync(connection, null, sql, ct, values);
    }

    public static async Task<long> ScalarLongAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql,
        CancellationToken ct, params object?[] values)
    {
        await using var command = Command(connection, transaction, sql, values);
        var value = await command.ExecuteScalarAsync(ct);
        if (value is null or DBNull) return 0;
        return Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    public static async Task<string?> ScalarStringAsync(
        NpgsqlDataSource source, string sql, CancellationToken ct, params object?[] values)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        return await ScalarStringAsync(connection, null, sql, ct, values);
    }

    public static async Task<string?> ScalarStringAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql,
        CancellationToken ct, params object?[] values)
    {
        await using var command = Command(connection, transaction, sql, values);
        var value = await command.ExecuteScalarAsync(ct);
        return value is null or DBNull ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
    }
}
