/**
 * Whether the sim is the window in front — so the overlays can get out of the
 * way when it is not.
 *
 * Electron only knows about its own windows, so this asks Windows directly:
 * the foreground window, the process that owns it, and that process's image
 * name. Polled rather than hooked. A WinEvent hook would need a callback from a
 * native thread into JS, and four cheap calls a quarter of a second apart cost
 * nothing measurable against a 60 Hz telemetry loop in the same process.
 *
 * Windows only, loaded lazily behind the platform check like `IRacingAdapter`,
 * so the tree still imports and runs on macOS — where there is no iRacing to
 * be in front of and the overlays simply stay up.
 */

import { basename } from "node:path";
import { createRequire } from "node:module";

import type * as Koffi from "koffi";

/** The sim's own window. Not `iRacingUI.exe`, the launcher — nobody drives in that. */
const SIM_IMAGE = /^iracingsim/i;

/** Enough for any real path; the API truncates rather than overruns. */
const MAX_PATH_CHARS = 1024;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export interface ForegroundWatcher {
  stop(): void;
}

interface Win32 {
  /** The foreground process's id, or null while nothing is in front (mid alt-tab). */
  foregroundPid(): number | null;
  imageName(pid: number): string | null;
}

function loadWin32(): Win32 {
  // createRequire: koffi is CommonJS with a native addon, and this file is ESM.
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const GetForegroundWindow = user32.func("void *__stdcall GetForegroundWindow()");
  const GetWindowThreadProcessId = user32.func(
    "uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)",
  );
  const OpenProcess = kernel32.func(
    "void *__stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)",
  );
  const QueryFullProcessImageNameW = kernel32.func(
    "int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, void *lpExeName, _Inout_ uint32_t *lpdwSize)",
  );
  const CloseHandle = kernel32.func("int __stdcall CloseHandle(void *hObject)");

  return {
    foregroundPid() {
      const hwnd: unknown = GetForegroundWindow();
      if (hwnd === null) return null;
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      return pid[0] === 0 ? null : pid[0]!;
    },
    imageName(pid) {
      const handle: unknown = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      // Elevated processes refuse a query from an unelevated one. That is not
      // the sim unless someone runs it as admin — and then neither would the
      // SDK connection be much use to us.
      if (handle === null) return null;
      try {
        const buffer = Buffer.alloc(MAX_PATH_CHARS * 2);
        const size = [MAX_PATH_CHARS];
        if (QueryFullProcessImageNameW(handle, 0, buffer, size) === 0) return null;
        return basename(buffer.toString("utf16le", 0, size[0]! * 2));
      } finally {
        CloseHandle(handle);
      }
    },
  };
}

/**
 * Call `onChange` whenever the sim gains or loses the foreground, starting with
 * the state right now. Null when this platform cannot tell — the caller should
 * then behave as though the sim were always in front.
 *
 * `ownWindowFocused` is for our own overlays: they are grabbable by default, so
 * clicking one takes the foreground from the sim, and hiding every overlay
 * because you touched one would be absurd. While one of them is in front the
 * state is left as it was.
 */
export function watchSimFocus(
  onChange: (focused: boolean) => void,
  ownOverlayFocused: () => boolean,
  intervalMs = 250,
): ForegroundWatcher | null {
  if (process.platform !== "win32") return null;

  let win32: Win32;
  try {
    win32 = loadWin32();
  } catch (err) {
    process.stderr.write(`cannot tell which window is in front, so overlays stay up: ${String(err)}\n`);
    return null;
  }

  let state: boolean | null = null;
  // Process ids are reused, but not within a quarter-second of each other in
  // practice, and re-reading the name only when the pid changes keeps a
  // steady-state tick to two calls.
  let lastPid = -1;
  let lastName: string | null = null;

  const tick = (): void => {
    let focused: boolean;
    try {
      const pid = win32.foregroundPid();
      // Nothing in front, briefly, during every alt-tab. Deciding on that
      // would flash the overlays off and on.
      if (pid === null) return;
      if (pid === process.pid) {
        if (ownOverlayFocused()) return;
        focused = false;
      } else {
        if (pid !== lastPid) {
          lastPid = pid;
          lastName = win32.imageName(pid);
        }
        focused = lastName !== null && SIM_IMAGE.test(lastName);
      }
    } catch {
      return;
    }
    if (focused !== state) {
      state = focused;
      onChange(focused);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
