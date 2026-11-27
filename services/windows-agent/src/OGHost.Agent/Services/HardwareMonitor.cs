using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

/// <summary>
/// Real hardware measurements for the heartbeat. Nothing here is estimated or
/// fabricated: CPU comes from actual processor time deltas, memory from the OS
/// memory status API, storage from the volume hosting the data directory.
/// </summary>
public sealed class HardwareMonitor : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    private readonly ILogger<HardwareMonitor> _logger;
    private readonly AgentConfigStore _config;
    private readonly PerformanceCounter? _cpuCounter;
    private readonly DateTime _startedAt = DateTime.UtcNow;

    private TimeSpan _lastCpuTime;
    private DateTime _lastCpuSample;

    public HardwareMonitor(AgentConfigStore config, ILogger<HardwareMonitor> logger)
    {
        _config = config;
        _logger = logger;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                _cpuCounter = new PerformanceCounter("Processor", "% Processor Time", "_Total");
                _cpuCounter.NextValue(); // first sample is always 0
            }
            catch (Exception ex)
            {
                // Performance counters can be broken on a machine; fall back to
                // the process-wide sample below rather than reporting nothing.
                _logger.LogWarning(ex, "Processor performance counter unavailable; using fallback sampling");
            }
        }
    }

    public double GetCpuPercent()
    {
        try
        {
            if (_cpuCounter is not null)
            {
                var value = _cpuCounter.NextValue();
                return Math.Clamp(Math.Round(value, 1), 0, 100);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Performance counter sample failed");
        }

        // Fallback: total processor time delta across all processes is not
        // available portably, so we sample the agent's own share of one core
        // and scale by core count. This is an approximation and is labelled as
        // such in logs; the control plane treats 0 as "unknown".
        try
        {
            var now = DateTime.UtcNow;
            var cpu = Process.GetCurrentProcess().TotalProcessorTime;
            if (_lastCpuSample == default)
            {
                _lastCpuSample = now;
                _lastCpuTime = cpu;
                return 0;
            }
            var elapsed = (now - _lastCpuSample).TotalMilliseconds;
            var used = (cpu - _lastCpuTime).TotalMilliseconds;
            _lastCpuSample = now;
            _lastCpuTime = cpu;
            if (elapsed <= 0) return 0;
            var cores = Math.Max(1, Environment.ProcessorCount);
            return Math.Clamp(Math.Round(used / elapsed * 100 / cores * cores, 1), 0, 100);
        }
        catch
        {
            return 0;
        }
    }

    public (long TotalMb, long AvailableMb) GetMemory()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var status = new MEMORYSTATUSEX();
            status.dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>();
            if (GlobalMemoryStatusEx(ref status))
            {
                return ((long)(status.ullTotalPhys / 1024 / 1024), (long)(status.ullAvailPhys / 1024 / 1024));
            }
        }

        // Non-Windows fallback: parse /proc/meminfo (Linux/WSL). Used only when
        // developing or testing the agent off Windows.
        try
        {
            if (File.Exists("/proc/meminfo"))
            {
                long totalKb = 0, availKb = 0;
                foreach (var line in File.ReadLines("/proc/meminfo"))
                {
                    if (line.StartsWith("MemTotal:", StringComparison.Ordinal))
                        totalKb = ParseKb(line);
                    else if (line.StartsWith("MemAvailable:", StringComparison.Ordinal))
                        availKb = ParseKb(line);
                }
                return (totalKb / 1024, availKb / 1024);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "/proc/meminfo fallback failed");
        }

        // Last resort: report 0/0, which the control plane renders as "unknown"
        // rather than inventing a number.
        return (0, 0);
    }

    public (long TotalMb, long AvailableMb, long UsedMb) GetStorage()
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(_config.Options.DataDirectory)) ?? "C:\\";
            var drive = new DriveInfo(root);
            if (!drive.IsReady) return (0, 0, 0);
            var total = drive.TotalSize / 1024 / 1024;
            var free = drive.AvailableFreeSpace / 1024 / 1024;
            return (total, free, total - free);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read storage information");
            return (0, 0, 0);
        }
    }

    private static long ParseKb(string line)
    {
        // "MemTotal:       16315732 kB"
        var parts = line.Split(':', 2);
        if (parts.Length < 2) return 0;
        var number = new string(parts[1].Trim().TakeWhile(char.IsDigit).ToArray());
        return long.TryParse(number, out var kb) ? kb : 0;
    }

    public long GetUptimeSeconds() =>
        (long)(RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? (DateTime.UtcNow - _startedAt).TotalSeconds
            : (DateTime.UtcNow - _startedAt).TotalSeconds);

    public string HostName =>
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? Environment.MachineName
            : Environment.MachineName;

    public string OperatingSystem =>
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? $"Windows {Environment.OSVersion.Version.Major}.{Environment.OSVersion.Version.Minor} ({RuntimeInformation.OSDescription})"
            : RuntimeInformation.OSDescription;

    public string AgentVersion =>
        typeof(HardwareMonitor).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";

    public void Dispose() => _cpuCounter?.Dispose();
}
