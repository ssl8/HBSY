using System.Security.Claims;
using Hbys.BuildingBlocks.Security;
using Xunit;

namespace DomainTests;

public sealed class RoleClaimsTests
{
    [Fact]
    public void Primary_role_uses_explicit_privilege_order()
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim("roles", "billing"),
            new Claim("roles", "doctor"),
            new Claim("roles", "admin")
        }, "test");
        Assert.Equal("admin", RoleClaims.PrimaryRole(new ClaimsPrincipal(identity)));
    }

    [Fact]
    public void Primary_role_is_case_insensitive_and_supports_registrar()
    {
        var labIdentity = new ClaimsIdentity(new[] { new Claim("roles", "LAB") }, "test");
        Assert.Equal("lab", RoleClaims.PrimaryRole(new ClaimsPrincipal(labIdentity)));

        var registrarIdentity = new ClaimsIdentity(new[] { new Claim("roles", "registrar"), new Claim("roles", "integration") }, "test");
        Assert.Equal("registrar", RoleClaims.PrimaryRole(new ClaimsPrincipal(registrarIdentity)));
    }

    [Fact]
    public void All_nine_canonical_roles_have_turkish_labels()
    {
        Assert.Equal(9, RoleClaims.AllRoles.Count);
        Assert.Contains("registrar", RoleClaims.AllRoles);
        Assert.Equal("Hasta Kayıt Görevlisi", RoleClaims.TurkishLabel("registrar"));
        Assert.Equal("Sistem Yöneticisi", RoleClaims.TurkishLabel("admin"));
    }

    [Fact]
    public void Missing_role_maps_to_user()
        => Assert.Equal("user", RoleClaims.PrimaryRole(new ClaimsPrincipal(new ClaimsIdentity())));
}
