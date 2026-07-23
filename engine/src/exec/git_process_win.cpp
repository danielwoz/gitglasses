// Win32 implementation of GitProcess: CreateProcessW with stdout/stderr
// pipes, cancellation via a kill-on-close job object (git's own children die
// with it), and the same 50ms cooperative cancellation poll cadence as the
// POSIX implementation.

#include "exec/git_process.h"

#include "exec/win_unicode.h"

#include <algorithm>
#include <cwctype>
#include <string_view>
#include <utility>
#include <vector>

namespace gg::exec {

namespace {

constexpr DWORD kPollIntervalMs = 50;

// Quotes one argument per the CommandLineToArgvW / CRT parsing rules: quote
// when needed, double backslash runs before a quote (or the closing quote),
// and escape embedded quotes.
void appendQuotedArg(std::wstring& commandLine, const std::wstring& arg) {
  if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    commandLine += arg;
    return;
  }
  commandLine += L'"';
  size_t backslashes = 0;
  for (const wchar_t c : arg) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    if (c == L'"') {
      // Backslashes preceding a quote must be doubled, plus one to escape
      // the quote itself.
      commandLine.append(backslashes * 2 + 1, L'\\');
      commandLine += L'"';
    } else {
      commandLine.append(backslashes, L'\\');
      commandLine += c;
    }
    backslashes = 0;
  }
  // Backslashes before the closing quote must be doubled.
  commandLine.append(backslashes * 2, L'\\');
  commandLine += L'"';
}

std::wstring buildCommandLine(const std::vector<std::string>& args) {
  std::wstring commandLine;
  for (const auto& arg : args) {
    if (!commandLine.empty()) commandLine += L' ';
    appendQuotedArg(commandLine, utf8ToWide(arg));
  }
  return commandLine;
}

// Name of a "NAME=value" environment entry. Entries beginning with '=' (the
// hidden drive-cwd variables) have their name start after that first char.
std::wstring_view envName(std::wstring_view entry) {
  const size_t eq = entry.find(L'=', entry.empty() || entry[0] != L'=' ? 0 : 1);
  return eq == std::wstring_view::npos ? entry : entry.substr(0, eq);
}

bool envNameEquals(std::wstring_view a, std::wstring_view b) {
  // Environment variable names are case-insensitive on Windows.
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (towupper(a[i]) != towupper(b[i])) return false;
  }
  return true;
}

// Inherited environment with `overrides` ("NAME=value", later entries win)
// replacing same-named variables, flattened to a double-NUL-terminated
// UTF-16 block sorted case-insensitively as CreateProcessW documents.
std::vector<wchar_t> buildEnvironmentBlock(const std::vector<std::string>& overrides) {
  std::vector<std::wstring> entries;
  if (wchar_t* raw = GetEnvironmentStringsW()) {
    for (wchar_t* cursor = raw; *cursor;) {
      const std::wstring entry(cursor);
      cursor += entry.size() + 1;
      entries.push_back(entry);
    }
    FreeEnvironmentStringsW(raw);
  }
  for (const auto& override8 : overrides) {
    const std::wstring entry = utf8ToWide(override8);
    const std::wstring_view name = envName(entry);
    entries.erase(std::remove_if(entries.begin(), entries.end(),
                                 [&name](const std::wstring& existing) {
                                   return envNameEquals(envName(existing), name);
                                 }),
                  entries.end());
    entries.push_back(entry);
  }
  std::sort(entries.begin(), entries.end(), [](const std::wstring& a, const std::wstring& b) {
    const size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i) {
      const wint_t x = towupper(a[i]);
      const wint_t y = towupper(b[i]);
      if (x != y) return x < y;
    }
    return a.size() < b.size();
  });
  std::vector<wchar_t> block;
  for (const auto& entry : entries) {
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

struct HandleCloser {
  HANDLE handle = nullptr;
  ~HandleCloser() {
    if (handle) CloseHandle(handle);
  }
  HANDLE release() { return std::exchange(handle, nullptr); }
};

}  // namespace

Result<GitProcess> GitProcess::spawn(const std::string& cwd, std::vector<std::string> args,
                                     const SpawnOpts& opts) {
  std::vector<std::string> fullArgs;
  fullArgs.reserve(args.size() + 3);
  fullArgs.push_back("git");
  fullArgs.push_back("-C");
  fullArgs.push_back(cwd);
  for (auto& a : args) fullArgs.push_back(std::move(a));
  std::wstring commandLine = buildCommandLine(fullArgs);

  // Scrubbed additions applied on top of the inherited environment (see the
  // POSIX implementation); caller entries come last so they win.
  std::vector<std::string> overrides = {"GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0",
                                        "LC_ALL=C"};
  overrides.insert(overrides.end(), opts.extraEnv.begin(), opts.extraEnv.end());
  std::vector<wchar_t> environment = buildEnvironmentBlock(overrides);

  SECURITY_ATTRIBUTES inheritable{};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;

  HandleCloser stdoutRead, stdoutWrite, stderrRead, stderrWrite, stdinNul;
  if (!CreatePipe(&stdoutRead.handle, &stdoutWrite.handle, &inheritable, 0) ||
      !CreatePipe(&stderrRead.handle, &stderrWrite.handle, &inheritable, 0)) {
    return Error{ErrorCode::Internal, "CreatePipe() failed"};
  }
  // Only the child-side ends may be inherited; an inherited read end would
  // keep the pipe open after the child exits and EOF would never arrive.
  SetHandleInformation(stdoutRead.handle, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stderrRead.handle, HANDLE_FLAG_INHERIT, 0);
  stdinNul.handle = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                &inheritable, OPEN_EXISTING, 0, nullptr);
  if (stdinNul.handle == INVALID_HANDLE_VALUE) {
    stdinNul.handle = nullptr;
    return Error{ErrorCode::Internal, "cannot open NUL for child stdin"};
  }

  // Kill-on-close job object: cancelling kills git and every child it
  // spawned (editors, hook shells), mirroring the POSIX process group.
  HandleCloser job;
  job.handle = CreateJobObjectW(nullptr, nullptr);
  if (!job.handle) return Error{ErrorCode::Internal, "CreateJobObjectW() failed"};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job.handle, JobObjectExtendedLimitInformation, &limits,
                          sizeof(limits));

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = stdinNul.handle;
  startup.hStdOutput = stdoutWrite.handle;
  startup.hStdError = stderrWrite.handle;

  PROCESS_INFORMATION info{};
  // lpApplicationName stays null so CreateProcessW resolves git.exe through
  // the standard search order (PATH included). Suspended start lets the
  // process join the job before it can spawn children of its own.
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE,
                      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                      environment.data(), nullptr, &startup, &info)) {
    return Error{ErrorCode::Internal,
                 "failed to spawn git: CreateProcessW error " + std::to_string(GetLastError())};
  }
  AssignProcessToJobObject(job.handle, info.hProcess);
  ResumeThread(info.hThread);
  CloseHandle(info.hThread);

  GitProcess process;
  process.process_ = info.hProcess;
  process.job_ = job.release();
  process.stdoutHandle_ = stdoutRead.release();
  process.stderrHandle_ = stderrRead.release();
  return process;
}

GitProcess::GitProcess(GitProcess&& other) noexcept
    : process_(other.process_),
      job_(other.job_),
      stdoutHandle_(other.stdoutHandle_),
      stderrHandle_(other.stderrHandle_),
      buffer_(std::move(other.buffer_)),
      bufferPos_(other.bufferPos_),
      eof_(other.eof_),
      stderr_(std::move(other.stderr_)),
      reaped_(other.reaped_),
      exitCode_(other.exitCode_) {
  other.process_ = nullptr;
  other.job_ = nullptr;
  other.stdoutHandle_ = nullptr;
  other.stderrHandle_ = nullptr;
  other.reaped_ = true;
}

GitProcess::~GitProcess() {
  if (process_ && !reaped_) {
    killGroup();
    WaitForSingleObject(process_, INFINITE);
  }
  if (stdoutHandle_) CloseHandle(stdoutHandle_);
  if (stderrHandle_) CloseHandle(stderrHandle_);
  if (process_) CloseHandle(process_);
  if (job_) CloseHandle(job_);
}

void GitProcess::killGroup() {
  if (job_) TerminateJobObject(job_, 1);
}

namespace {

// Nonblocking pipe read: appends whatever is currently available. Returns
// false once the write side is gone and the pipe is drained (EOF).
bool readAvailable(HANDLE pipe, std::string& sink) {
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
      return false;  // broken pipe: child exited and the buffer is drained
    }
    if (available == 0) return true;
    char chunk[65536];
    DWORD wanted = available < sizeof(chunk) ? available : static_cast<DWORD>(sizeof(chunk));
    DWORD got = 0;
    if (!ReadFile(pipe, chunk, wanted, &got, nullptr) || got == 0) return false;
    sink.append(chunk, got);
  }
}

}  // namespace

void GitProcess::drainStderr(bool blocking) {
  if (!stderrHandle_) return;
  const size_t before = stderr_.size();
  if (!readAvailable(stderrHandle_, stderr_)) return;
  if (blocking && stderr_.size() == before) {
    Sleep(kPollIntervalMs);
    readAvailable(stderrHandle_, stderr_);
  }
}

bool GitProcess::fillBuffer(const CancelToken& token) {
  if (eof_) return false;
  for (;;) {
    if (token.cancelled()) {
      killGroup();
      throw CancelledError();
    }
    const size_t before = buffer_.size();
    const bool open = readAvailable(stdoutHandle_, buffer_);
    if (buffer_.size() > before) return true;
    if (!open) {
      eof_ = true;
      return false;
    }
    drainStderr(/*blocking=*/false);
    Sleep(kPollIntervalMs);
  }
}

bool GitProcess::readLine(std::string& out, const CancelToken& token) {
  for (;;) {
    size_t newline = buffer_.find('\n', bufferPos_);
    if (newline != std::string::npos) {
      out.assign(buffer_, bufferPos_, newline - bufferPos_);
      bufferPos_ = newline + 1;
      // Compact once the consumed prefix dominates the buffer.
      if (bufferPos_ > 1 << 20 && bufferPos_ > buffer_.size() / 2) {
        buffer_.erase(0, bufferPos_);
        bufferPos_ = 0;
      }
      return true;
    }
    if (!fillBuffer(token)) {
      if (bufferPos_ < buffer_.size()) {  // final line without trailing newline
        out.assign(buffer_, bufferPos_, buffer_.size() - bufferPos_);
        bufferPos_ = buffer_.size();
        return true;
      }
      return false;
    }
  }
}

std::string GitProcess::readAll(const CancelToken& token) {
  while (fillBuffer(token)) {
  }
  std::string out = buffer_.substr(bufferPos_);
  bufferPos_ = buffer_.size();
  return out;
}

int GitProcess::wait(const CancelToken& token) {
  if (reaped_) return exitCode_;
  for (;;) {
    if (token.cancelled()) {
      killGroup();
      WaitForSingleObject(process_, INFINITE);
      reaped_ = true;
      throw CancelledError();
    }
    drainStderr(/*blocking=*/false);
    if (WaitForSingleObject(process_, kPollIntervalMs) == WAIT_OBJECT_0) {
      // Drain everything the child wrote before exiting.
      readAvailable(stderrHandle_, stderr_);
      DWORD code = 0;
      GetExitCodeProcess(process_, &code);
      exitCode_ = static_cast<int>(code);
      reaped_ = true;
      return exitCode_;
    }
  }
}

}  // namespace gg::exec
