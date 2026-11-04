// Streams one app's audio, or everything except it, to stdout as 48 kHz stereo 16-bit PCM.
// Usage: clfed-audio.exe include|exclude Discord.exe [DiscordPTB.exe ...]
// Exit codes: 2 bad arguments, 3 target missing, 4 activation failed, 5 capture failed.
#include <initguid.h>
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propidl.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <wchar.h>
#include <string>
#include <vector>

struct LoopbackParams { DWORD targetProcessId; DWORD mode; };
struct ActivationParams { DWORD type; LoopbackParams loopback; };
const DWORD ACTIVATION_PROCESS_LOOPBACK = 1;
const DWORD MODE_INCLUDE_TREE = 0;
const DWORD MODE_EXCLUDE_TREE = 1;
typedef HRESULT(WINAPI *ActivateFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *, IActivateAudioInterfaceAsyncOperation **);

class Completion : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG refs = 1;
public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;
  STDMETHODIMP QueryInterface(REFIID id, void **out) override {
    if (id == __uuidof(IUnknown) || id == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
    } else if (id == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject *>(this);
    } else { *out = nullptr; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
  STDMETHODIMP_(ULONG) Release() override { LONG n = InterlockedDecrement(&refs); if (!n) delete this; return n; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT status = E_FAIL;
    IUnknown *unknown = nullptr;
    HRESULT hr = op->GetActivateResult(&status, &unknown);
    result = SUCCEEDED(hr) ? status : hr;
    if (SUCCEEDED(result) && unknown) result = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void **>(&client));
    if (unknown) unknown->Release();
    SetEvent(done);
    return S_OK;
  }
};

// The root of the newest matching tree, so every child process of the app is covered.
static DWORD findRoot(const std::vector<std::wstring> &names) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  struct Item { DWORD pid, parent; bool match; };
  std::vector<Item> items;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  for (BOOL ok = Process32FirstW(snap, &entry); ok; ok = Process32NextW(snap, &entry)) {
    bool match = false;
    for (const auto &name : names) if (!_wcsicmp(entry.szExeFile, name.c_str())) match = true;
    items.push_back({entry.th32ProcessID, entry.th32ParentProcessID, match});
  }
  CloseHandle(snap);
  for (const auto &item : items) {
    if (!item.match) continue;
    bool parentMatches = false;
    for (const auto &other : items) if (other.pid == item.parent && other.match) parentMatches = true;
    if (!parentMatches) return item.pid;
  }
  return 0;
}

// Prints the program behind the window in front, so a clip can be filed under its name.
static int printForeground() {
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  HANDLE process = pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
  if (!process) return 3;
  wchar_t path[MAX_PATH];
  DWORD length = MAX_PATH;
  BOOL ok = QueryFullProcessImageNameW(process, 0, path, &length);
  CloseHandle(process);
  if (!ok) return 3;
  const wchar_t *name = wcsrchr(path, L'\\');
  name = name ? name + 1 : path;
  char utf8[MAX_PATH * 3];
  int size = WideCharToMultiByte(CP_UTF8, 0, name, -1, utf8, sizeof(utf8), nullptr, nullptr);
  if (size > 0) fputs(utf8, stdout);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && !wcscmp(argv[1], L"foreground")) return printForeground();
  if (argc < 3) return 2;
  bool include = !wcscmp(argv[1], L"include");
  std::vector<std::wstring> names(argv + 2, argv + argc);
  DWORD target = findRoot(names);
  if (!target) {
    if (include) return 3;
    target = GetCurrentProcessId();
  }
  _setmode(_fileno(stdout), _O_BINARY);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;
  HMODULE mmdevapi = LoadLibraryW(L"Mmdevapi.dll");
  ActivateFn activate = mmdevapi ? reinterpret_cast<ActivateFn>(GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync")) : nullptr;
  if (!activate) return 4;

  ActivationParams params{ACTIVATION_PROCESS_LOOPBACK, {target, include ? MODE_INCLUDE_TREE : MODE_EXCLUDE_TREE}};
  PROPVARIANT prop;
  PropVariantInit(&prop);
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE *>(&params);
  Completion *completion = new Completion();
  IActivateAudioInterfaceAsyncOperation *operation = nullptr;
  HRESULT hr = activate(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &prop, completion, &operation);
  if (FAILED(hr)) return 4;
  WaitForSingleObject(completion->done, 5000);
  if (FAILED(completion->result) || !completion->client) return 4;
  IAudioClient *client = completion->client;

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = 4;
  format.nAvgBytesPerSec = 192000;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, &format, nullptr);
  if (FAILED(hr)) return 5;
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient *capture = nullptr;
  if (FAILED(client->SetEventHandle(ready)) || FAILED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void **>(&capture)))) return 5;
  if (FAILED(client->Start())) return 5;

  std::vector<BYTE> silence;
  for (;;) {
    WaitForSingleObject(ready, 200);
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) return 5;
      size_t bytes = frames * 4;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.assign(bytes, 0); data = silence.data(); }
      bool written = fwrite(data, 1, bytes, stdout) == bytes && fflush(stdout) == 0;
      capture->ReleaseBuffer(frames);
      if (!written) return 0;  // The app closed the pipe, so stop quietly.
    }
  }
}
