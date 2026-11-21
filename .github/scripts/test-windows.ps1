$ErrorActionPreference = 'Stop'

# An elevated runner can assign new files to Administrators. Exercise the same
# user-owned storage as a normal desktop session, including in child processes.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class TestFileOwner {
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int kind, ref IntPtr owner, int size);

    public static void UseCurrentUser() {
        using (var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query | TokenAccessLevels.AdjustDefault)) {
            if (identity.User.Equals(identity.Owner)) return;
            var sid = new byte[identity.User.BinaryLength];
            identity.User.GetBinaryForm(sid, 0);
            var pinned = GCHandle.Alloc(sid, GCHandleType.Pinned);
            try {
                var owner = pinned.AddrOfPinnedObject();
                const int TokenOwner = 4;
                if (!SetTokenInformation(identity.Token, TokenOwner, ref owner, IntPtr.Size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { pinned.Free(); }
        }
    }
}
'@
[TestFileOwner]::UseCurrentUser()
$probe = New-TemporaryFile
try {
    $owner = (Get-Acl -LiteralPath $probe.FullName).GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User) {
        throw 'The Windows test account must own its temporary files.'
    }
} finally { Remove-Item -LiteralPath $probe.FullName }
& bun test @args
exit $LASTEXITCODE
