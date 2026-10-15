"""Is iRacing the foreground window? Widgets fade out while it isn't (alt-tabbed away)."""

from __future__ import annotations

import os
import sys

SIM_EXE_PREFIX = "iracingsim"  # iRacingSim64DX11.exe


def sim_focused() -> bool | None:
    """True / False on Windows, None where it can't be told (mock on macOS, errors)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            buf = ctypes.create_unicode_buffer(260)
            size = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return None
        finally:
            kernel32.CloseHandle(handle)
        return os.path.basename(buf.value).lower().startswith(SIM_EXE_PREFIX)
    except Exception:
        return None
