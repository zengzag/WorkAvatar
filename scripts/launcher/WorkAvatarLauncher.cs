// WorkAvatar 稳定启动器
//
// 用途：安装到固定目录（升级/卸载流程不会清空），桌面与开始菜单快捷方式指向它，
// 用户固定的是它；它读取同目录下的 app-path.txt，拉起真正安装目录中的主程序。
// 这样升级时主程序目录被重建，也不会影响已固定到任务栏的启动器。

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class WorkAvatarLauncher
{
    private const string AppPathFile = "app-path.txt";
    private const uint MB_ICONERROR = 0x10;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    private static int Main(string[] args)
    {
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string cfg = Path.Combine(baseDir, AppPathFile);

        string target = ReadTarget(cfg);
        if (string.IsNullOrEmpty(target) || !File.Exists(target))
        {
            MessageBox(IntPtr.Zero, "未找到 WorkAvatar 主程序，可能已被卸载或移动，请重新安装 WorkAvatar。", "WorkAvatar", MB_ICONERROR);
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = target,
            WorkingDirectory = Path.GetDirectoryName(target),
            UseShellExecute = false,
        };
        if (args.Length > 0)
        {
            psi.Arguments = BuildArguments(args);
        }

        try
        {
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox(IntPtr.Zero, "启动 WorkAvatar 失败：" + ex.Message, "WorkAvatar", MB_ICONERROR);
            return 1;
        }
    }

    private static string ReadTarget(string cfg)
    {
        try
        {
            if (!File.Exists(cfg)) return null;
            using (var reader = new StreamReader(cfg, Encoding.Unicode, true))
            {
                return reader.ReadToEnd().Trim().Trim('"');
            }
        }
        catch
        {
            return null;
        }
    }

    private static string BuildArguments(string[] args)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    // 按 Windows 命令行规则还原参数（C# Windows 版无 ArgumentList，只能自行拼接）
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return value;
        }

        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                sb.Append(c);
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                backslashes = 0;
                sb.Append(c);
            }
        }
        sb.Append('\\', backslashes);
        sb.Append('"');
        return sb.ToString();
    }
}
