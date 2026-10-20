#include "services/blame/blame_service.h"

#include <spdlog/spdlog.h>

#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <sstream>
#include <utility>

#include "core/git2.h"
#include "exec/git_process.h"
#include "exec/parsers/incremental_blame.h"
#include "util/sha256.h"
#include "util/temp_file.h"
#include "util/utf8_path.h"

namespace gg::services {

namespace {

// `git blame --contents` takes a file argument for the dirty buffer; TempFile
// removes it on every exit path, including cancellation.
using util::TempFile;

// The directory git runs in and resolves relative config paths against.
std::string gitCwd(const core::Repo& repo) {
  return repo.workdir().empty() ? repo.gitdir() : repo.workdir();
}

// `relative` under `base`, as UTF-8 text: libgit2 takes UTF-8 paths on every
// platform.
std::string joinPath(const std::string& base, const std::string& relative) {
  if (base.empty() || base.back() == '/' || base.back() == '\\') return base + relative;
  return base + '/' + relative;
}

// The bytes of a file, or nullopt when it cannot be read.
std::optional<std::string> readFile(const std::string& utf8Path) {
  std::ifstream in(util::pathFromUtf8(utf8Path), std::ios::binary);
  if (!in) return std::nullopt;
  std::ostringstream text;
  text << in.rdbuf();
  return std::move(text).str();
}

bool isRegularFile(const std::string& utf8Path) {
  std::error_code ec;
  return std::filesystem::is_regular_file(util::pathFromUtf8(utf8Path), ec);
}

struct ConfigDeleter {
  void operator()(git_config* config) const { git_config_free(config); }
};
using ConfigPtr = std::unique_ptr<git_config, ConfigDeleter>;

// The repository's effective config (system, global and local files).
ConfigPtr configSnapshot(const core::Repo& repo) {
  git_config* raw = nullptr;
  if (git_repository_config_snapshot(&raw, repo.raw()) != 0) return nullptr;
  return ConfigPtr(raw);
}

// Every value of a multi-valued setting, in the order git reads them.
std::vector<std::string> configValues(git_config* config, const char* name) {
  std::vector<std::string> values;
  if (!config) return values;
  git_config_iterator* iter = nullptr;
  if (git_config_multivar_iterator_new(&iter, config, name, nullptr) != 0) return values;
  git_config_entry* entry = nullptr;
  while (git_config_next(&entry, iter) == 0) values.emplace_back(entry->value ? entry->value : "");
  git_config_iterator_free(iter);
  return values;
}

// A path-valued setting as git reads it: `~/` expanded, and a relative path
// taken from the directory git runs in.
std::string configPath(const std::string& value, const std::string& base) {
  std::string expanded = value;
  git_buf buf = GIT_BUF_INIT;
  if (git_config_parse_path(&buf, value.c_str()) == 0 && buf.ptr) expanded = buf.ptr;
  git_buf_dispose(&buf);
  if (util::pathFromUtf8(expanded).is_absolute()) return expanded;
  return joinPath(base, expanded);
}

// Name of the ignore-revs file GitHub and most tools read when nothing is
// configured.
constexpr const char* kDefaultIgnoreRevsFile = ".git-blame-ignore-revs";

// Reports a configured ignore-revs file that does not exist, once per path.
void reportMissingIgnoreRevsFile(const std::string& path) {
  static std::mutex mutex;
  static std::set<std::string> reported;
  std::lock_guard lock(mutex);
  if (reported.size() > 256 || !reported.insert(path).second) return;
  spdlog::warn("blame: skipping blame.ignoreRevsFile '{}', which does not exist", path);
}

// The ignore-revs files the CLI backend hands to git. A configured file that
// does not exist makes git refuse to blame at all ("could not open object
// name list"), and a global blame.ignoreRevsFile naming a file most
// repositories lack is common, so only the files that exist are passed. When
// nothing is configured, the repository's own .git-blame-ignore-revs is used.
std::vector<std::string> ignoreRevsFiles(const core::Repo& repo, git_config* config) {
  const std::string base = gitCwd(repo);
  const std::vector<std::string> values = configValues(config, "blame.ignoreRevsFile");
  std::vector<std::string> files;
  if (values.empty()) {
    if (!repo.workdir().empty()) {
      const std::string candidate = joinPath(repo.workdir(), kDefaultIgnoreRevsFile);
      if (isRegularFile(candidate)) files.push_back(candidate);
    }
    return files;
  }
  for (const std::string& value : values) {
    // An empty value resets the list read so far, as it does for git.
    if (value.empty()) {
      files.clear();
      continue;
    }
    const std::string file = configPath(value, base);
    if (isRegularFile(file)) {
      files.push_back(file);
    } else {
      reportMissingIgnoreRevsFile(file);
    }
  }
  return files;
}

// Appends a length-framed entry, so no two different inputs digest alike.
void addInput(std::string& material, const std::string& label,
              const std::optional<std::string>& bytes) {
  material += label;
  material += '\0';
  material += bytes ? std::to_string(bytes->size()) + ':' + *bytes : std::string("-");
  material += '\0';
}

// Digest of the inputs besides the file's history that change a blame: the
// ignore-revs files and the mailmap sources (the working tree's .mailmap,
// mailmap.file and mailmap.blob). A cached result is reused only while they
// are unchanged.
std::string inputsDigest(const core::Repo& repo, git_config* config,
                         const std::vector<std::string>& ignoreRevs) {
  std::string material;
  for (const std::string& file : ignoreRevs)
    addInput(material, "ignore-revs " + file, readFile(file));
  if (!repo.workdir().empty()) {
    addInput(material, "mailmap", readFile(joinPath(repo.workdir(), ".mailmap")));
  }
  const auto mailmapFiles = configValues(config, "mailmap.file");
  if (!mailmapFiles.empty()) {
    const std::string file = configPath(mailmapFiles.back(), gitCwd(repo));
    addInput(material, "mailmap.file " + file, readFile(file));
  }
  // A bare repository reads its mailmap from HEAD:.mailmap unless told
  // otherwise; the blob id stands for its contents.
  const auto mailmapBlobs = configValues(config, "mailmap.blob");
  std::string blobSpec = mailmapBlobs.empty() ? std::string() : mailmapBlobs.back();
  if (blobSpec.empty() && repo.isBare()) blobSpec = "HEAD:.mailmap";
  if (!blobSpec.empty()) {
    std::optional<std::string> blobId;
    git_object* blob = nullptr;
    if (git_revparse_single(&blob, repo.raw(), blobSpec.c_str()) == 0) {
      blobId = core::oidToHex(*git_object_id(blob));
      git_object_free(blob);
    }
    addInput(material, "mailmap.blob " + blobSpec, blobId);
  }
  return util::sha256Hex(material);
}

// Whether the path's filter attribute hands it to Git LFS.
bool isLfsTracked(const core::Repo& repo, const std::string& path) {
  const char* value = nullptr;
  if (git_attr_get(&value, repo.raw(), GIT_ATTR_CHECK_FILE_THEN_INDEX, path.c_str(), "filter") !=
      0) {
    return false;
  }
  return git_attr_value(value) == GIT_ATTR_VALUE_STRING && std::strcmp(value, "lfs") == 0;
}

// Working-tree or editor bytes in the form git stores them: the clean side of
// the repository's built-in filters (autocrlf, eol=crlf, ident), which `git
// blame` applies before comparing with the blobs. Left as they are when no
// filter applies or one fails.
std::string toOdbForm(const core::Repo& repo, const std::string& path, std::string contents) {
  git_filter_list* filters = nullptr;
  if (git_filter_list_load(&filters, repo.raw(), nullptr, path.c_str(), GIT_FILTER_TO_ODB,
                           GIT_FILTER_ALLOW_UNSAFE) != 0 ||
      !filters) {
    return contents;
  }
  git_buf clean = GIT_BUF_INIT;
  if (git_filter_list_apply_to_buffer(&clean, filters, contents.data(), contents.size()) == 0) {
    contents.assign(clean.ptr ? clean.ptr : "", clean.size);
  }
  git_buf_dispose(&clean);
  git_filter_list_free(filters);
  return contents;
}

// Resolves (commit OID, blob OID) for a cacheable request. Returns nullopt
// when either id is unavailable (unresolvable rev, path absent from the
// commit, unreadable working-tree file), which makes the request uncacheable.
std::optional<std::pair<std::string, std::string>> resolveOids(const core::Repo& repo,
                                                               const BlameRequest& request) {
  git_object* commitObj = nullptr;
  const std::string revspec = request.rev.value_or("HEAD");
  if (git_revparse_single(&commitObj, repo.raw(), revspec.c_str()) != 0) return std::nullopt;
  std::unique_ptr<git_object, decltype(&git_object_free)> commitGuard(commitObj,
                                                                      git_object_free);

  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, commitObj, GIT_OBJECT_COMMIT) != 0) return std::nullopt;
  std::unique_ptr<git_object, decltype(&git_object_free)> peeledGuard(peeled, git_object_free);

  char commitHex[GIT_OID_HEXSZ + 1] = {};
  git_oid_fmt(commitHex, git_object_id(peeled));

  std::string blobHex;
  if (request.rev) {
    // Blob as recorded in the blamed commit's tree.
    git_object* blob = nullptr;
    const std::string spec = std::string(commitHex) + ":" + request.path;
    if (git_revparse_single(&blob, repo.raw(), spec.c_str()) != 0) return std::nullopt;
    char hex[GIT_OID_HEXSZ + 1] = {};
    git_oid_fmt(hex, git_object_id(blob));
    git_object_free(blob);
    blobHex = hex;
  } else {
    // Working-tree blame: hash the on-disk bytes. Content addressing keeps
    // the key exact — any edit changes the blob OID and misses the cache.
    git_oid oid;
    const std::string file = joinPath(repo.workdir(), request.path);
    if (git_odb_hashfile(&oid, file.c_str(), GIT_OBJECT_BLOB) != 0) return std::nullopt;
    char hex[GIT_OID_HEXSZ + 1] = {};
    git_oid_fmt(hex, &oid);
    blobHex = hex;
  }
  return std::make_pair(std::string(commitHex), blobHex);
}

// git_time offset (minutes east of UTC) -> "+HHMM"/"-HHMM".
std::string formatTimezone(int offsetMinutes) {
  const char sign = offsetMinutes < 0 ? '-' : '+';
  const int magnitude = offsetMinutes < 0 ? -offsetMinutes : offsetMinutes;
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "%c%02d%02d", sign, magnitude / 60, magnitude % 60);
  return buffer;
}

exec::BlameSignature toBlameSignature(const git_signature* sig) {
  exec::BlameSignature out;
  if (!sig) return out;
  out.name = sig->name ? sig->name : "";
  out.email = sig->email ? sig->email : "";
  out.time = static_cast<std::int64_t>(sig->when.time);
  out.timezone = formatTimezone(sig->when.offset);
  return out;
}

// A commit signature with its name and email mapped through the mailmap,
// keeping the original time.
exec::BlameSignature mappedSignature(const git_signature* sig, const git_mailmap* mailmap) {
  exec::BlameSignature out = toBlameSignature(sig);
  if (!sig || !mailmap) return out;
  const char* name = nullptr;
  const char* email = nullptr;
  if (git_mailmap_resolve(&name, &email, mailmap, sig->name, sig->email) == 0) {
    out.name = name ? name : out.name;
    out.email = email ? email : out.email;
  }
  return out;
}

struct BlameDeleter {
  void operator()(git_blame* blame) const { git_blame_free(blame); }
};
using BlamePtr = std::unique_ptr<git_blame, BlameDeleter>;

}  // namespace

std::optional<std::string> BlameService::cacheKey(const core::Repo& repo,
                                                  const BlameRequest& request, BlameBackend backend,
                                                  const std::string& inputs) {
  if (request.contents) return std::nullopt;  // dirty buffers are never cached
  auto oids = resolveOids(repo, request);
  if (!oids) return std::nullopt;
  // The commit pins the history and the blob the contents, but two paths
  // with the same contents still have different histories, so the path is
  // part of the key. The options and inputs change attribution too.
  std::string options;
  if (request.options.ignoreWhitespace) options += 'w';
  if (request.options.moves == MoveDetection::WithinFile) options += 'M';
  if (request.options.moves == MoveDetection::AcrossFiles) options += 'C';
  if (request.options.ignoreRevs) options += 'i';
  // The backend marker keeps CLI-parsed and libgit2-computed entries apart:
  // the two backends can attribute rename-boundary hunks differently, so a
  // cached result must only ever serve requests for the same backend.
  return cache::BlameCache::makeKey(oids->first, oids->second, request.path) + '\0' + options +
         '\0' + inputs + (backend == BlameBackend::Cli ? "|cli" : "|libgit2");
}

Result<BlameSummary> BlameService::blame(const core::Repo& repo, const BlameRequest& request,
                                         const CancelToken& token, const HunkFn& emit) {
  const BlameBackend backend =
      request.forceBackend.value_or(cliAvailable_ ? BlameBackend::Cli : BlameBackend::LibGit2);
  const ConfigPtr config = configSnapshot(repo);
  std::vector<std::string> ignoreRevs;
  if (backend == BlameBackend::Cli && request.options.ignoreRevs) {
    ignoreRevs = ignoreRevsFiles(repo, config.get());
  }
  const bool lfs = isLfsTracked(repo, request.path);
  const std::optional<std::string> key =
      cacheKey(repo, request, backend, inputsDigest(repo, config.get(), ignoreRevs));
  if (key) {
    if (auto cached = cache_.get(*key)) {
      for (const auto& hunk : cached->hunks) {
        token.throwIfCancelled();
        emit(hunk);
      }
      return BlameSummary{cached, /*fromCache=*/true, lfs};
    }
  }

  auto computed = backend == BlameBackend::Cli
                      ? blameWithCli(repo, request, ignoreRevs, token, emit)
                      : blameWithLibGit2(repo, request, token, emit);
  if (!computed) return computed.error();
  if (key) cache_.put(*key, computed.value());
  return BlameSummary{std::move(computed).value(), /*fromCache=*/false, lfs};
}

Result<std::shared_ptr<const cache::BlameResult>> BlameService::blameWithCli(
    const core::Repo& repo, const BlameRequest& request,
    const std::vector<std::string>& ignoreRevsFiles, const CancelToken& token, const HunkFn& emit) {
  // core.quotePath=false keeps non-ASCII path bytes as they are in the
  // filename and previous lines; git still quotes a path holding a quote, a
  // backslash or a control character, which the parser decodes.
  std::vector<std::string> args = {"-c", "core.quotePath=false", "blame", "--incremental"};
  if (request.options.ignoreWhitespace) args.push_back("-w");
  if (request.options.moves == MoveDetection::WithinFile) args.push_back("-M");
  if (request.options.moves == MoveDetection::AcrossFiles) args.push_back("-C");
  // The configured ignore-revs list is replaced by the files that exist, so a
  // missing one cannot fail the blame.
  args.push_back("--no-ignore-revs-file");
  for (const std::string& file : ignoreRevsFiles) args.push_back("--ignore-revs-file=" + file);
  std::optional<TempFile> contentsFile;
  if (request.contents) {
    auto file = TempFile::create(*request.contents, "gg-contents-");
    if (!file) return file.error();
    contentsFile.emplace(std::move(file.value()));
    args.push_back("--contents");
    args.push_back(contentsFile->path());
  }
  if (request.rev) {
    // Sits before the "--" separator, so it must not look like an option.
    if (exec::looksLikeGitOption(*request.rev)) {
      return Error{ErrorCode::InvalidParams, "'rev' may not begin with '-'"};
    }
    args.push_back(*request.rev);
  }
  args.push_back("--");
  args.push_back(request.path);

  auto process = exec::GitProcess::spawn(gitCwd(repo), std::move(args));
  if (!process) return process.error();

  auto result = std::make_shared<cache::BlameResult>();
  exec::IncrementalBlameParser parser([&](const exec::BlameHunk& hunk) {
    result->hunks.push_back(hunk);
    emit(hunk);
  });

  std::string line;
  while (process.value().readLine(line, token)) {
    parser.feedLine(line);
  }
  parser.finish();

  const int exitCode = process.value().wait(token);
  if (process.value().timedOut()) {
    return Error{ErrorCode::GitError, "git blame timed out after " +
                                          std::to_string(process.value().timeout().count()) + "ms"};
  }
  if (exitCode != 0) {
    return Error{ErrorCode::GitError,
                 "git blame failed (" + std::to_string(exitCode) +
                     "): " + process.value().stderrOutput()};
  }

  result->commits = parser.commits();
  return std::shared_ptr<const cache::BlameResult>(std::move(result));
}

// In-process fallback via git_blame_file/git_blame_buffer. Known divergences
// from `git blame` (all acceptable; results never share cache entries with
// the CLI backend):
//   - Weaker cross-file rename attribution: clean whole-file renames are
//     followed, but similarity-based pairing can attribute rename+edit or
//     copy cases to the renaming commit instead of the true origin.
//   - No `previous` (blame-parent) hunk fields: libgit2 does not report the
//     parent commit a hunk was passed from.
//   - ignore-revs files and move/copy detection (-M/-C) are not supported.
// Names are mapped through the mailmap, as the CLI does.
Result<std::shared_ptr<const cache::BlameResult>> BlameService::blameWithLibGit2(
    const core::Repo& repo, const BlameRequest& request, const CancelToken& token,
    const HunkFn& emit) {
  // Default flags mirror `git blame` defaults (no -M/-C copy tracking).
  git_blame_options options;
  if (git_blame_options_init(&options, GIT_BLAME_OPTIONS_VERSION) != 0) {
    return core::gitError("blame options");
  }
  if (request.options.ignoreWhitespace) options.flags |= GIT_BLAME_IGNORE_WHITESPACE;

  git_mailmap* rawMailmap = nullptr;
  if (git_mailmap_from_repository(&rawMailmap, repo.raw()) != 0) rawMailmap = nullptr;
  const std::unique_ptr<git_mailmap, decltype(&git_mailmap_free)> mailmap(rawMailmap,
                                                                          git_mailmap_free);
  if (request.rev) {
    git_object* obj = nullptr;
    if (git_revparse_single(&obj, repo.raw(), request.rev->c_str()) != 0) {
      return core::gitError("resolve '" + *request.rev + "'");
    }
    std::unique_ptr<git_object, decltype(&git_object_free)> objGuard(obj, git_object_free);
    git_object* peeled = nullptr;
    if (git_object_peel(&peeled, obj, GIT_OBJECT_COMMIT) != 0) {
      return core::gitError("'" + *request.rev + "' does not point to a commit");
    }
    std::unique_ptr<git_object, decltype(&git_object_free)> peeledGuard(peeled, git_object_free);
    git_oid_cpy(&options.newest_commit, git_object_id(peeled));
  }

  token.throwIfCancelled();
  git_blame* rawBase = nullptr;
  if (git_blame_file(&rawBase, repo.raw(), request.path.c_str(), &options) != 0) {
    return core::gitError("blame '" + request.path + "'");
  }
  BlamePtr base(rawBase);

  // Working-tree (and dirty-buffer) blame layers the current contents over
  // the HEAD blame — the same shape as `git blame [--contents]` on a dirty
  // file. Lines absent from HEAD come back with a zero OID. The contents are
  // compared in the form git stores them, so a CRLF checkout of LF blobs
  // (core.autocrlf, eol=crlf) is not read as every line changed.
  git_blame* effective = base.get();
  BlamePtr buffer;
  if (!request.rev) {
    std::string contents;
    if (request.contents) {
      contents = *request.contents;
    } else {
      auto onDisk = readFile(joinPath(repo.workdir(), request.path));
      if (!onDisk) return Error{ErrorCode::GitError, "cannot read '" + request.path + "'"};
      contents = std::move(*onDisk);
    }
    contents = toOdbForm(repo, request.path, std::move(contents));
    token.throwIfCancelled();
    git_blame* rawBuffer = nullptr;
    if (git_blame_buffer(&rawBuffer, base.get(), contents.data(), contents.size()) != 0) {
      return core::gitError("blame buffer for '" + request.path + "'");
    }
    buffer.reset(rawBuffer);
    effective = buffer.get();
  }

  auto result = std::make_shared<cache::BlameResult>();
  const size_t hunkCount = git_blame_hunkcount(effective);
  for (size_t i = 0; i < hunkCount; ++i) {
    token.throwIfCancelled();
    const git_blame_hunk* raw = git_blame_hunk_byindex(effective, i);
    if (!raw) continue;

    const bool uncommitted = git_oid_is_zero(&raw->final_commit_id) != 0;
    exec::BlameHunk hunk;
    hunk.sha = uncommitted ? exec::kUncommittedSha : core::oidToHex(raw->final_commit_id);
    hunk.resultLine = static_cast<std::uint32_t>(raw->final_start_line_number);
    hunk.originalLine = static_cast<std::uint32_t>(raw->orig_start_line_number);
    hunk.lineCount = static_cast<std::uint32_t>(raw->lines_in_hunk);
    hunk.path = raw->orig_path ? raw->orig_path : request.path;

    auto [it, inserted] = result->commits.try_emplace(hunk.sha);
    exec::BlameCommit& commit = it->second;
    if (inserted) {
      commit.sha = hunk.sha;
      if (uncommitted) {
        // Synthetic entry matching the CLI's for not-yet-committed lines.
        exec::BlameSignature signature;
        signature.name = "Not Committed Yet";
        signature.email = "not.committed.yet";
        signature.time = static_cast<std::int64_t>(std::time(nullptr));
        signature.timezone = "+0000";
        commit.author = signature;
        commit.committer = std::move(signature);
        commit.summary = "Version of " + request.path + " from " + request.path;
      } else {
        git_commit* rawCommit = nullptr;
        if (git_commit_lookup(&rawCommit, repo.raw(), &raw->final_commit_id) != 0) {
          return core::gitError("lookup commit " + hunk.sha);
        }
        core::CommitPtr commitGuard(rawCommit);
        commit.author = mappedSignature(git_commit_author(rawCommit), mailmap.get());
        commit.committer = mappedSignature(git_commit_committer(rawCommit), mailmap.get());
        const char* summary = git_commit_summary(rawCommit);
        commit.summary = summary ? summary : "";
      }
    }
    if (raw->boundary) commit.boundary = true;

    result->hunks.push_back(hunk);
    emit(hunk);
  }
  return std::shared_ptr<const cache::BlameResult>(std::move(result));
}

}  // namespace gg::services
