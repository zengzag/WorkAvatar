// WorkAvatar Windows 文件沙箱运行器
//
// 用法：
//   WorkAvatarSandbox.exe --workspace <dir> --temp <dir> [--cwd <dir>] --mode workspace-write -- <program> [args...]
//
// 做的事：
//   1. 从工作区/临时目录派生能力 SID（S-1-4-x-y），幂等地给目录加上
//      「Allow 能力 SID + Deny Everyone 的 FILE_DELETE_CHILD + Low 完整性标签」
//   2. 用 WRITE_RESTRICTED 创建受限令牌（restricting SID = logon + Everyone + 能力 SID），
//      并降到 Low 完整性、修补默认 DACL
//   3. 以该令牌 CreateProcessAsUser 启动子进程，透传 stdio，镜像退出码
//
// 失败契约：任何失败都向 stderr 打印 "workavatar-sandbox: <detail>" 并以 127 退出，
// 上层据此判定为「沙箱故障」而非「命令被拒绝」；绝不会以完整权限启动子进程。

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class WorkAvatarSandbox
{
    private const string Signature = "workavatar-sandbox:";
    private const int FailureExitCode = 127;

    // ── Win32 常量 ──
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;

    private const uint DISABLE_MAX_PRIVILEGE = 0x0001;
    private const uint LUA_TOKEN = 0x0004;
    private const uint WRITE_RESTRICTED = 0x0008;

    private const int TokenGroups = 2;
    private const int TokenDefaultDacl = 6;
    private const int TokenIntegrityLevel = 25;
    private const uint SE_GROUP_LOGON_ID = 0xC0000000;

    private const int WinWorldSid = 1;
    private const int WinLowLabelSid = 66;
    private const uint SECURITY_MAX_SID_SIZE = 68;

    private const int SE_FILE_OBJECT = 1;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint LABEL_SECURITY_INFORMATION = 0x00000010;

    private const byte ACCESS_ALLOWED_ACE_TYPE = 0x00;
    private const byte ACCESS_DENIED_ACE_TYPE = 0x01;
    private const byte SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;

    private const uint GRANT_ACCESS = 1;
    private const uint DENY_ACCESS = 3;
    private const uint SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x03;
    private const uint CONTAINER_INHERIT_ACE = 0x02;

    private const uint TRUSTEE_IS_SID = 0;
    private const uint TRUSTEE_IS_UNKNOWN = 0;
    private const uint NO_MULTIPLE_TRUSTEE = 0;

    private const uint FILE_GENERIC_WRITE = 0x120116;
    private const uint DELETE = 0x00010000;
    private const uint FILE_DELETE_CHILD = 0x00000040;
    private const uint STANDARD_RIGHTS_WRITE = 0x00120000;
    private const uint GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
    private const uint FILE_ALL_ACCESS = 0x001F01FF;

    private const uint SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x00000001;
    private const uint SE_GROUP_INTEGRITY = 0x00000020;
    private const uint ACL_REVISION = 2;
    private const uint LPTR = 0x0040;

    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint ACL_SIZE_INFORMATION_CLASS = 2;

    // ── 结构体 ──
    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL
    {
        public SID_AND_ATTRIBUTES Label;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ACL_SIZE_INFORMATION
    {
        public uint AceCount;
        public uint AclBytesInUse;
        public uint AclBytesFree;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TRUSTEE
    {
        public IntPtr pMultipleTrustee;
        public uint MultipleTrusteeOperation;
        public uint TrusteeForm;
        public uint TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EXPLICIT_ACCESS
    {
        public uint grfAccessPermissions;
        public uint grfAccessMode;
        public uint grfInheritance;
        public TRUSTEE Trustee;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    // ── P/Invoke ──
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingToken, uint flags, uint disableCount, IntPtr[] disableSids,
        uint deleteCount, IntPtr[] privilegesToDelete, uint restrictCount,
        SID_AND_ATTRIBUTES[] restrictingSids, out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint length, out uint needed);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, uint length);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateWellKnownSid(int type, IntPtr domainSid, IntPtr sid, ref uint size);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CopySid(uint length, IntPtr destination, IntPtr source);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool IsValidSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool EqualSid(IntPtr a, IntPtr b);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetNamedSecurityInfoW(
        string name, int objectType, uint info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfoW(
        string name, int objectType, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint SetEntriesInAclW(
        uint count, EXPLICIT_ACCESS[] entries, IntPtr oldAcl, out IntPtr newAcl);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool InitializeAcl(IntPtr acl, uint size, uint revision);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AddMandatoryAce(IntPtr acl, uint revision, uint aceFlags, uint policy, IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAclInformation(
        IntPtr acl, out ACL_SIZE_INFORMATION info, uint size, uint infoClass);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(
        IntPtr token, string applicationName, string commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    // ── 入口 ──
    private static int Main(string[] args)
    {
        try
        {
            string workspace = null;
            string temp = null;
            string cwd = null;
            string mode = "workspace-write";
            var tail = new List<string>();
            int i = 0;
            while (i < args.Length)
            {
                string token = args[i];
                if (token == "--")
                {
                    i++;
                    break;
                }
                if (i + 1 >= args.Length) return Fail("missing value after " + token);
                string value = args[++i];
                if (token == "--workspace") workspace = value;
                else if (token == "--temp") temp = value;
                else if (token == "--cwd") cwd = value;
                else if (token == "--mode") mode = value;
                else return Fail("unknown argument: " + token);
                i++;
            }
            for (; i < args.Length; i++) tail.Add(args[i]);

            if (workspace == null) return Fail("missing --workspace");
            if (temp == null) return Fail("missing --temp");
            if (mode != "workspace-write") return Fail("unsupported mode: " + mode);
            if (tail.Count == 0) return Fail("missing command after --");
            if (!Directory.Exists(workspace)) return Fail("workspace is not an existing directory: " + workspace);
            if (!Directory.Exists(temp)) return Fail("temp is not an existing directory: " + temp);
            if (cwd != null && !Directory.Exists(cwd)) return Fail("cwd is not an existing directory: " + cwd);

            string workspaceFull = Path.GetFullPath(workspace).TrimEnd('\\');
            string tempFull = Path.GetFullPath(temp).TrimEnd('\\');
            // 未指定 --cwd 时以工作区为工作目录；指定时按调用方要求（working_dir 参数）执行
            string cwdFull = cwd != null ? Path.GetFullPath(cwd) : workspaceFull;
            // 临时目录允许落在工作区内（例如工作区本身就是系统临时目录）：此时它本来就可写，
            // 额外授权是幂等的，不构成越界。
            // 子进程继承本进程环境（CreateProcessAsUser 传 null 环境块），这里统一把 TMP/TEMP
            // 指向已授权的私有临时目录，避免子进程写到未授权的系统临时目录。
            Environment.SetEnvironmentVariable("TMP", tempFull);
            Environment.SetEnvironmentVariable("TEMP", tempFull);

            string workspaceSid = DeriveCapabilitySid(workspaceFull.ToLowerInvariant(), false);
            string tempSid = DeriveCapabilitySid("temp\0" + tempFull.ToLowerInvariant(), true);

            IntPtr lowSid = CreateWellKnown(WinLowLabelSid);
            IntPtr worldSid = CreateWellKnown(WinWorldSid);

            GrantWrite(workspaceFull, workspaceSid, lowSid, worldSid);
            GrantWrite(tempFull, tempSid, lowSid, worldSid);

            IntPtr restricted = CreateRestricted(workspaceSid, tempSid, lowSid, worldSid);
            string program = tail[0];
            var childArgs = tail.GetRange(1, tail.Count - 1);
            int exitCode = SpawnConfined(restricted, program, childArgs.ToArray(), cwdFull);
            return exitCode;
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    private static int Fail(string detail)
    {
        try { Console.Error.WriteLine(Signature + " " + detail); } catch { }
        return FailureExitCode;
    }

    /** 由路径派生能力 SID：S-1-4-x-y（临时目录多一段固定子授权） */
    private static string DeriveCapabilitySid(string seed, bool temp)
    {
        byte[] hash;
        using (var sha = SHA256.Create())
        {
            hash = sha.ComputeHash(Encoding.UTF8.GetBytes(seed));
        }
        const long modulus = 1073741822L;
        long first = (BitConverter.ToUInt32(hash, 0) % modulus) + 1;
        long second = (BitConverter.ToUInt32(hash, 4) % modulus) + 1;
        return temp
            ? string.Format("S-1-4-{0}-{1}-1", first, second)
            : string.Format("S-1-4-{0}-{1}", first, second);
    }

    private static IntPtr CreateWellKnown(int type)
    {
        IntPtr sid = Marshal.AllocHGlobal((int)SECURITY_MAX_SID_SIZE);
        uint size = SECURITY_MAX_SID_SIZE;
        if (!CreateWellKnownSid(type, IntPtr.Zero, sid, ref size))
        {
            throw Win32("CreateWellKnownSid(" + type + ")");
        }
        if (!IsValidSid(sid)) throw Win32("IsValidSid");
        return sid;
    }

    private static IntPtr ParseSid(string value)
    {
        IntPtr sid;
        if (!ConvertStringSidToSidW(value, out sid)) throw Win32("ConvertStringSidToSidW(" + value + ")");
        return sid;
    }

    // ── 目录授权 ──
    private static void GrantWrite(string path, string sidString, IntPtr lowSid, IntPtr worldSid)
    {
        IntPtr sid = ParseSid(sidString);
        if (HasExactGrant(path, sid, lowSid, worldSid)) return;
        ApplyGrant(path, sid, lowSid, worldSid);
    }

    private static bool HasExactGrant(string path, IntPtr sid, IntPtr lowSid, IntPtr worldSid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetNamedSecurityInfoW(
            path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw Win32("GetNamedSecurityInfoW(" + path + ")", result);
        try
        {
            if (dacl == IntPtr.Zero || sacl == IntPtr.Zero) return false;
            return HasAce(dacl, ACCESS_ALLOWED_ACE_TYPE, SUB_CONTAINERS_AND_OBJECTS_INHERIT, GRANT_MASK, sid)
                && HasAce(dacl, ACCESS_DENIED_ACE_TYPE, CONTAINER_INHERIT_ACE, FILE_DELETE_CHILD, worldSid)
                && HasAce(sacl, SYSTEM_MANDATORY_LABEL_ACE_TYPE, SUB_CONTAINERS_AND_OBJECTS_INHERIT, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSid);
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    private static bool HasAce(IntPtr acl, byte aceType, uint aceFlags, uint mask, IntPtr sid)
    {
        ACL_SIZE_INFORMATION info;
        if (!GetAclInformation(acl, out info, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), ACL_SIZE_INFORMATION_CLASS))
        {
            return false;
        }
        if (info.AceCount == 0 || info.AceCount > 4096) return false;
        for (uint index = 0; index < info.AceCount; index++)
        {
            IntPtr ace;
            if (!GetAce(acl, index, out ace)) return false;
            byte type = Marshal.ReadByte(ace, 0);
            byte flags = Marshal.ReadByte(ace, 1);
            uint aceMask = (uint)Marshal.ReadInt32(ace, 4);
            if (type == aceType && flags == aceFlags && aceMask == mask
                && EqualSid(new IntPtr(ace.ToInt64() + 8), sid))
            {
                return true;
            }
        }
        return false;
    }

    private static void ApplyGrant(string path, IntPtr sid, IntPtr lowSid, IntPtr worldSid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetNamedSecurityInfoW(
            path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw Win32("GetNamedSecurityInfoW(" + path + ")", result);

        IntPtr newAcl = IntPtr.Zero;
        IntPtr labelAcl = IntPtr.Zero;
        try
        {
            var entries = new EXPLICIT_ACCESS[2];
            entries[0] = MakeEntry(worldSid, DENY_ACCESS, FILE_DELETE_CHILD, CONTAINER_INHERIT_ACE);
            entries[1] = MakeEntry(sid, GRANT_ACCESS, GRANT_MASK, SUB_CONTAINERS_AND_OBJECTS_INHERIT);

            uint merge = SetEntriesInAclW(2, entries, dacl, out newAcl);
            if (merge != 0) throw Win32("SetEntriesInAclW(" + path + ")", merge);

            labelAcl = BuildLowLabelAcl(lowSid);
            uint apply = SetNamedSecurityInfoW(
                path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, newAcl, labelAcl);
            if (apply != 0) throw Win32("SetNamedSecurityInfoW(" + path + ")", apply);
        }
        finally
        {
            if (newAcl != IntPtr.Zero) LocalFree(newAcl);
            if (labelAcl != IntPtr.Zero) LocalFree(labelAcl);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    private static EXPLICIT_ACCESS MakeEntry(IntPtr sid, uint accessMode, uint mask, uint inheritance)
    {
        var entry = new EXPLICIT_ACCESS();
        entry.grfAccessPermissions = mask;
        entry.grfAccessMode = accessMode;
        entry.grfInheritance = inheritance;
        entry.Trustee.pMultipleTrustee = IntPtr.Zero;
        entry.Trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
        entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        entry.Trustee.ptstrName = sid;
        return entry;
    }

    private static IntPtr BuildLowLabelAcl(IntPtr lowSid)
    {
        uint sidLength = GetLengthSid(lowSid);
        uint size = (8 + 4 + 4 + sidLength + 3) & ~3u;
        IntPtr acl = LocalAlloc(LPTR, new UIntPtr(size));
        if (acl == IntPtr.Zero) throw Win32("LocalAlloc(label ACL)");
        if (!InitializeAcl(acl, size, ACL_REVISION)) throw Win32("InitializeAcl");
        if (!AddMandatoryAce(acl, ACL_REVISION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSid))
        {
            throw Win32("AddMandatoryAce");
        }
        return acl;
    }

    // ── 令牌 ──
    private static IntPtr CreateRestricted(string workspaceSid, string tempSid, IntPtr lowSid, IntPtr worldSid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION, false, System.Diagnostics.Process.GetCurrentProcess().Id);
        if (process == IntPtr.Zero) throw Win32("OpenProcess");

        IntPtr currentToken;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, out currentToken))
            {
                throw Win32("OpenProcessToken");
            }
        }
        finally
        {
            CloseHandle(process);
        }

        IntPtr logonSid = FindLogonSid(currentToken);
        IntPtr workspaceSidPtr = ParseSid(workspaceSid);
        IntPtr tempSidPtr = ParseSid(tempSid);

        var restricting = new SID_AND_ATTRIBUTES[4];
        restricting[0].Sid = logonSid;
        restricting[1].Sid = worldSid;
        restricting[2].Sid = workspaceSidPtr;
        restricting[3].Sid = tempSidPtr;

        IntPtr restricted;
        if (!CreateRestrictedToken(
            currentToken,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0, null, 0, null, (uint)restricting.Length, restricting, out restricted))
        {
            throw Win32("CreateRestrictedToken");
        }
        CloseHandle(currentToken);

        SetIntegrity(restricted, lowSid);
        SetDefaultDaclGrant(restricted, tempSidPtr);
        return restricted;
    }

    private static IntPtr FindLogonSid(IntPtr token)
    {
        uint needed;
        GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw Win32("GetTokenInformation(TokenGroups size)");

        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, TokenGroups, buffer, needed, out needed))
            {
                throw Win32("GetTokenInformation(TokenGroups)");
            }
            uint count = (uint)Marshal.ReadInt32(buffer, 0);
            if (count > 4096) throw new Exception("implausible token group count: " + count);
            int offset = IntPtr.Size == 8 ? 8 : 4;
            for (uint index = 0; index < count; index++)
            {
                IntPtr entry = new IntPtr(buffer.ToInt64() + offset + index * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
                IntPtr sid = Marshal.ReadIntPtr(entry, 0);
                uint attributes = (uint)Marshal.ReadInt32(entry, IntPtr.Size);
                if ((attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
                uint sidLength = GetLengthSid(sid);
                IntPtr copy = Marshal.AllocHGlobal((int)sidLength);
                if (!CopySid(sidLength, copy, sid)) throw Win32("CopySid(logon SID)");
                return copy;
            }
            throw new Exception("no logon SID found in token groups");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void SetIntegrity(IntPtr token, IntPtr lowSid)
    {
        var label = new TOKEN_MANDATORY_LABEL();
        label.Label.Sid = lowSid;
        label.Label.Attributes = SE_GROUP_INTEGRITY;
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)));
        try
        {
            Marshal.StructureToPtr(label, buffer, false);
            if (!SetTokenInformation(token, TokenIntegrityLevel, buffer, (uint)Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL))))
            {
                throw Win32("SetTokenInformation(TokenIntegrityLevel)");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /** 给令牌默认 DACL 合并一条 restricting SID 的完全访问 ACE：新建对象（匿名管道等）才能通过第二道检查 */
    private static void SetDefaultDaclGrant(IntPtr token, IntPtr sid)
    {
        uint needed;
        GetTokenInformation(token, TokenDefaultDacl, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw Win32("GetTokenInformation(TokenDefaultDacl size)");

        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        IntPtr newAcl = IntPtr.Zero;
        try
        {
            if (!GetTokenInformation(token, TokenDefaultDacl, buffer, needed, out needed))
            {
                throw Win32("GetTokenInformation(TokenDefaultDacl)");
            }
            IntPtr currentDacl = Marshal.ReadIntPtr(buffer, 0);
            if (currentDacl == IntPtr.Zero) throw new Exception("token carries no default DACL");

            var entries = new EXPLICIT_ACCESS[1];
            entries[0] = MakeEntry(sid, GRANT_ACCESS, FILE_ALL_ACCESS, 0);
            uint merge = SetEntriesInAclW(1, entries, currentDacl, out newAcl);
            if (merge != 0) throw Win32("SetEntriesInAclW(default DACL)", merge);

            IntPtr info = Marshal.AllocHGlobal(IntPtr.Size);
            try
            {
                Marshal.WriteIntPtr(info, newAcl);
                if (!SetTokenInformation(token, TokenDefaultDacl, info, (uint)IntPtr.Size))
                {
                    throw Win32("SetTokenInformation(TokenDefaultDacl)");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(info);
            }
        }
        finally
        {
            if (newAcl != IntPtr.Zero) LocalFree(newAcl);
            Marshal.FreeHGlobal(buffer);
        }
    }

    // ── 启动子进程 ──
    private static int SpawnConfined(IntPtr token, string program, string[] args, string workingDirectory)
    {
        var commandLine = new StringBuilder();
        commandLine.Append(Quote(program));
        for (int i = 0; i < args.Length; i++)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(args[i]));
        }

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = InheritableStandardHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = InheritableStandardHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = InheritableStandardHandle(STD_ERROR_HANDLE);

        PROCESS_INFORMATION info;
        bool started = CreateProcessAsUserW(
            token, null, commandLine.ToString(), IntPtr.Zero, IntPtr.Zero, true, 0,
            IntPtr.Zero, workingDirectory, ref startup, out info);
        if (!started) throw Win32("CreateProcessAsUserW(" + program + ")");

        try
        {
            WaitForSingleObject(info.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(info.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
            return unchecked((int)exitCode);
        }
        finally
        {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
    }

    private static IntPtr InheritableStandardHandle(int which)
    {
        IntPtr handle = GetStdHandle(which);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return handle;
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return handle;
    }

    /** 按 CommandLineToArgvW 规则加引号 */
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var builder = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(c);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static Exception Win32(string api)
    {
        return Win32(api, (uint)Marshal.GetLastWin32Error());
    }

    private static Exception Win32(string api, uint code)
    {
        string message;
        try { message = new Win32Exception((int)code).Message; }
        catch { message = "error " + code; }
        return new Exception(api + " failed (Win32 " + code + "): " + message);
    }
}
