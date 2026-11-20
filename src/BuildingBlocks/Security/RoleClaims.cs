using System.Security.Claims;

namespace Hbys.BuildingBlocks.Security;

public static class RoleClaims
{
    private static readonly string[] Priority =
    [
        "admin",
        "doctor",
        "nurse",
        "lab",
        "radiology",
        "pharmacist",
        "billing",
        "registrar",
        "integration"
    ];

    public static IReadOnlyList<string> AllRoles => Priority;

    public static string PrimaryRole(ClaimsPrincipal principal)
    {
        var roles = principal.FindAll("roles").Select(c => c.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return Priority.FirstOrDefault(roles.Contains) ?? "user";
    }

    public static string Username(ClaimsPrincipal principal) =>
        principal.FindFirst("preferred_username")?.Value
        ?? principal.FindFirst(ClaimTypes.Name)?.Value
        ?? "unknown";

    public static string DisplayName(ClaimsPrincipal principal) =>
        principal.FindFirst("name")?.Value ?? Username(principal);

    public static string TurkishLabel(string role) => role.ToLowerInvariant() switch
    {
        "admin" => "Sistem Yöneticisi",
        "doctor" => "Hekim",
        "nurse" => "Hemşire",
        "lab" => "Laboratuvar Teknisyeni",
        "radiology" => "Radyoloji Teknisyeni",
        "pharmacist" => "Eczacı",
        "billing" => "Faturalama Uzmanı",
        "registrar" => "Hasta Kayıt Görevlisi",
        "integration" => "Entegrasyon Operatörü",
        _ => "Kullanıcı"
    };
}
