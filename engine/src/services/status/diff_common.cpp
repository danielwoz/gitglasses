#include "services/status/diff_common.h"

#include <git2/sys/hashsig.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string_view>
#include <system_error>
#include <unordered_map>
#include <utility>

#include "exec/git_runner.h"
#include "rpc/dispatcher.h"

namespace gg::services::status_detail {

namespace {

// Bytes of path arguments per git invocation. UTF-8 never takes fewer bytes
// than UTF-16 takes code units, so this bounds the Windows command line too,
// leaving room for the executable, the working directory and the options.
constexpr size_t kArgvBudget = 16 * 1024;

char statusLetter(git_delta_t status) {
  switch (status) {
    case GIT_DELTA_ADDED:
    case GIT_DELTA_UNTRACKED:
      return 'A';
    case GIT_DELTA_DELETED:
      return 'D';
    case GIT_DELTA_RENAMED:
      return 'R';
    case GIT_DELTA_COPIED:
      return 'C';
    case GIT_DELTA_TYPECHANGE:
      return 'T';
    case GIT_DELTA_CONFLICTED:
      return 'U';
    default:
      return 'M';
  }
}

bool isRegularFileMode(std::uint32_t mode) {
  return mode == GIT_FILEMODE_BLOB || mode == GIT_FILEMODE_BLOB_EXECUTABLE;
}

// A filesystem path from UTF-8 text. On Windows a path built from a narrow
// string goes through the ANSI code page and misreads non-ASCII names.
std::filesystem::path pathFromUtf8(const std::string& text) {
  std::u8string utf8;
  utf8.reserve(text.size());
  for (const char c : text) utf8.push_back(static_cast<char8_t>(c));
  return std::filesystem::path(utf8);
}

std::string lowercase(std::string text) {
  for (char& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return text;
}

// The attribute's value when it is set to a string (`filter=lfs`), else "".
std::string stringAttribute(git_repository* repo, const std::string& path, const char* name) {
  const char* value = nullptr;
  if (git_attr_get(&value, repo, GIT_ATTR_CHECK_FILE_THEN_INDEX, path.c_str(), name) != 0) {
    return {};
  }
  return git_attr_value(value) == GIT_ATTR_VALUE_STRING ? std::string(value) : std::string();
}

bool parseHunkHeader(const std::string& line, HunkBlock& out) {
  if (line.rfind("@@ -", 0) != 0) return false;
  const char* p = line.c_str() + 4;
  char* end = nullptr;
  out.oldStart = std::strtol(p, &end, 10);
  if (end == p) return false;
  p = end;
  out.oldLines = 1;
  if (*p == ',') {
    ++p;
    out.oldLines = std::strtol(p, &end, 10);
    if (end == p) return false;
    p = end;
  }
  if (p[0] != ' ' || p[1] != '+') return false;
  p += 2;
  out.newStart = std::strtol(p, &end, 10);
  if (end == p) return false;
  p = end;
  out.newLines = 1;
  if (*p == ',') {
    ++p;
    out.newLines = std::strtol(p, &end, 10);
    if (end == p) return false;
    p = end;
  }
  if (std::strncmp(p, " @@", 3) != 0) return false;
  out.trailing = std::string(p + 3);
  return true;
}

}  // namespace

Result<core::TreePtr> commitTree(git_commit* commit) {
  git_tree* tree = nullptr;
  if (git_commit_tree(&tree, commit) != 0) return core::gitError("read commit tree");
  return core::TreePtr(tree);
}

Result<core::CommitPtr> resolveCommit(const core::Repo& repo, const std::string& rev) {
  git_object* raw = nullptr;
  if (git_revparse_single(&raw, repo.raw(), rev.c_str()) != 0) {
    return core::gitError("resolve '" + rev + "'");
  }
  core::ObjectPtr object(raw);
  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, object.get(), GIT_OBJECT_COMMIT) != 0) {
    return core::gitError("'" + rev + "' does not point to a commit");
  }
  return core::CommitPtr(reinterpret_cast<git_commit*>(peeled));
}

bool isPartialClone(git_repository* repo) {
  git_config* raw = nullptr;
  if (git_repository_config_snapshot(&raw, repo) != 0) return false;
  std::unique_ptr<git_config, decltype(&git_config_free)> config(raw, git_config_free);
  git_buf extension = GIT_BUF_INIT;
  if (git_config_get_string_buf(&extension, config.get(), "extensions.partialclone") == 0) {
    git_buf_dispose(&extension);
    return true;
  }
  bool promisor = false;
  git_config_foreach_match(
      config.get(), "^remote\\..+\\.promisor$",
      [](const git_config_entry* entry, void* payload) {
        int value = 0;
        if (git_config_parse_bool(&value, entry->value) == 0 && value) {
          *static_cast<bool*>(payload) = true;
        }
        return 0;
      },
      &promisor);
  return promisor;
}

Result<void> fetchThroughGit(const core::Repo& repo, std::vector<std::string> args,
                             const CancelToken& token) {
  exec::RunOpts opts;
  opts.rawOutput = true;
  opts.timeout = exec::kNetworkGitTimeout;
  const std::string cwd = repo.workdir().empty() ? repo.gitdir() : repo.workdir();
  auto status = exec::runGit(cwd, std::move(args), opts, token, [](std::string) {});
  if (!status) return status.error();
  if (status.value().exitCode != 0) {
    return Error{ErrorCode::GitError, "fetching missing objects failed (" +
                                          std::to_string(status.value().exitCode) +
                                          "): " + status.value().stderrText};
  }
  return {};
}

namespace {

// How the repository's config asks porcelain diffs to pair renames.
struct RenameRules {
  bool renames = true;
  bool copies = false;
  std::size_t limit = 1000;  // git's default diff.renameLimit; 0 means none
};

RenameRules renameRules(git_repository* repo) {
  RenameRules rules;
  git_config* raw = nullptr;
  if (git_repository_config_snapshot(&raw, repo) != 0) return rules;
  std::unique_ptr<git_config, decltype(&git_config_free)> config(raw, git_config_free);
  git_buf value = GIT_BUF_INIT;
  if (git_config_get_string_buf(&value, config.get(), "diff.renames") == 0) {
    const std::string text = lowercase(std::string(value.ptr, value.size));
    git_buf_dispose(&value);
    int enabled = 1;
    if (text == "copies" || text == "copy") {
      rules.copies = true;
    } else if (git_config_parse_bool(&enabled, text.c_str()) == 0 && !enabled) {
      rules.renames = false;
    }
  }
  std::int64_t limit = 0;
  if (git_config_get_int64(&limit, config.get(), "diff.renamelimit") == 0) {
    // git reads zero or a negative limit as no limit.
    rules.limit = limit > 0 ? static_cast<std::size_t>(limit) : 0;
  }
  return rules;
}

struct OidHash {
  std::size_t operator()(const git_oid& oid) const {
    std::size_t hash = 0;
    std::memcpy(&hash, oid.id, sizeof(hash));
    return hash;
  }
};

struct OidEqual {
  bool operator()(const git_oid& a, const git_oid& b) const { return git_oid_equal(&a, &b); }
};

std::string_view baseName(std::string_view path) {
  const size_t slash = path.rfind('/');
  return slash == std::string_view::npos ? path : path.substr(slash + 1);
}

// A listed file and where its line stats come from: delta `index` of the
// tree diff, or, for a rename or copy paired by similarity and for a change
// of file type, the content of the two sides. An exact rename or copy
// changes no line; only its binary verdict is looked up.
struct PlannedChange {
  TreeFileChange file;
  std::size_t index = 0;
  bool unchangedContent = false;
  bool fromSides = false;
  git_oid oldId{};
  git_oid newId{};
  std::uint32_t oldMode = GIT_FILEMODE_BLOB;
  std::uint32_t newMode = GIT_FILEMODE_BLOB;
};

// One side of a comparison by content: a blob, or for a submodule the line
// naming its commit, which is what git compares.
struct SideContent {
  std::unique_ptr<git_blob, decltype(&git_blob_free)> blob{nullptr, git_blob_free};
  std::string text;

  const char* data() const {
    return blob ? static_cast<const char*>(git_blob_rawcontent(blob.get())) : text.data();
  }
  std::size_t size() const {
    return blob ? static_cast<std::size_t>(git_blob_rawsize(blob.get())) : text.size();
  }
};

// Loads one side, or returns the libgit2 error code (GIT_ENOTFOUND for a blob
// a partial clone lacks).
int loadSide(git_repository* repo, const git_oid& id, std::uint32_t mode, SideContent& out) {
  if (mode == GIT_FILEMODE_COMMIT) {
    out.text = "Subproject commit " + core::oidToHex(id) + "\n";
    return 0;
  }
  git_blob* raw = nullptr;
  if (const int error = git_blob_lookup(&raw, repo, &id); error != 0) return error;
  out.blob.reset(raw);
  return 0;
}

// Line counts and the binary verdict from a built patch.
void statsFromPatch(git_patch* patch, TreeFileChange& file) {
  // Building the patch loads both sides, which is when binary content is
  // detected.
  file.binary = (git_patch_get_delta(patch)->flags & GIT_DIFF_FLAG_BINARY) != 0;
  size_t contextLines = 0, additions = 0, deletions = 0;
  if (!file.binary && git_patch_line_stats(&contextLines, &additions, &deletions, patch) == 0) {
    file.additions = additions;
    file.deletions = deletions;
  }
}

// Whether git treats `path` as binary for diffs: the `diff` attribute unset
// (`-diff`, or the `binary` macro) or naming a driver configured with
// `binary = true`. Empty when the content decides.
std::optional<bool> binaryByAttribute(git_repository* repo, const std::string& path) {
  const char* value = nullptr;
  if (git_attr_get(&value, repo, 0, path.c_str(), "diff") != 0) return std::nullopt;
  switch (git_attr_value(value)) {
    case GIT_ATTR_VALUE_FALSE:
      return true;
    case GIT_ATTR_VALUE_TRUE:
      return false;
    case GIT_ATTR_VALUE_STRING: {
      git_config* raw = nullptr;
      if (git_repository_config_snapshot(&raw, repo) != 0) return std::nullopt;
      std::unique_ptr<git_config, decltype(&git_config_free)> config(raw, git_config_free);
      int binary = 0;
      const std::string key = std::string("diff.") + value + ".binary";
      if (git_config_get_bool(&binary, config.get(), key.c_str()) == 0 && binary) return true;
      return std::nullopt;
    }
    default:
      return std::nullopt;
  }
}

// The binary verdict for content a rename left unchanged, as git's diff
// makes it: the attributes first, then a NUL byte among the first 8000.
int unchangedContentStats(git_repository* repo, const git_oid& id, TreeFileChange& file) {
  if (const auto byAttribute = binaryByAttribute(repo, file.path)) {
    file.binary = *byAttribute;
    return 0;
  }
  git_blob* rawBlob = nullptr;
  if (const int error = git_blob_lookup(&rawBlob, repo, &id); error != 0) return error;
  std::unique_ptr<git_blob, decltype(&git_blob_free)> blob(rawBlob, git_blob_free);
  const auto size =
      static_cast<std::size_t>(std::min<git_object_size_t>(git_blob_rawsize(blob.get()), 8000));
  file.binary = std::memchr(git_blob_rawcontent(blob.get()), 0, size) != nullptr;
  return 0;
}

// Fills `change.file`'s stats. Returns the libgit2 error code when the patch
// cannot be built (a blob missing from a partial clone reports
// GIT_ENOTFOUND).
int fillStats(git_repository* repo, git_diff* diff, PlannedChange& change) {
  TreeFileChange& file = change.file;
  if (change.unchangedContent) {
    const git_diff_file& content = git_diff_get_delta(diff, change.index)->new_file;
    // A submodule's commit is not in this repository and has no lines.
    if (content.mode == GIT_FILEMODE_COMMIT) return 0;
    return unchangedContentStats(repo, content.id, file);
  }
  git_patch* rawPatch = nullptr;
  if (change.fromSides) {
    SideContent oldSide;
    SideContent newSide;
    if (const int error = loadSide(repo, change.oldId, change.oldMode, oldSide); error != 0) {
      return error;
    }
    if (const int error = loadSide(repo, change.newId, change.newMode, newSide); error != 0) {
      return error;
    }
    const char* oldPath = file.origPath.empty() ? file.path.c_str() : file.origPath.c_str();
    // Two blobs are compared with the repository's diff attributes, as git
    // does; a submodule side has no attributes to apply.
    const int error =
        oldSide.blob && newSide.blob
            ? git_patch_from_blobs(&rawPatch, oldSide.blob.get(), oldPath, newSide.blob.get(),
                                   file.path.c_str(), nullptr)
            : git_patch_from_buffers(&rawPatch, oldSide.data(), oldSide.size(), oldPath,
                                     newSide.data(), newSide.size(), file.path.c_str(), nullptr);
    if (error != 0) return error;
  } else {
    const git_diff_delta* delta = git_diff_get_delta(diff, change.index);
    file.binary = (delta->flags & GIT_DIFF_FLAG_BINARY) != 0;
    if (file.binary) return 0;
    if (const int error = git_patch_from_diff(&rawPatch, diff, change.index); error != 0) {
      return error;
    }
  }
  if (!rawPatch) return 0;
  core::PatchPtr patch(rawPatch);
  statsFromPatch(patch.get(), file);
  return 0;
}

// Minimum similarity (percent) for an inexact rename, git's default -M50%.
constexpr int kRenameThreshold = 50;

// Minimum similarity for pairing the only remaining source and the only
// remaining destination that share a base name: halfway between the rename
// threshold and identical content, as git sets it.
constexpr int kBaseNameThreshold = kRenameThreshold + (100 - kRenameThreshold) / 2;

// A rename candidate's content signature: libgit2's line-hash signature (the
// metric its own rename detection uses) and the content size.
struct Signature {
  std::uint64_t size = 0;
  git_hashsig* hashsig = nullptr;

  Signature() = default;
  Signature(const Signature&) = delete;
  Signature& operator=(const Signature&) = delete;
  Signature(Signature&& other) noexcept : size(other.size), hashsig(other.hashsig) {
    other.hashsig = nullptr;
  }
  ~Signature() {
    if (hashsig) git_hashsig_free(hashsig);
  }
};

// Signs the blob `id`, or returns the libgit2 error code (GIT_ENOTFOUND for a
// blob a partial clone lacks).
int signBlob(git_repository* repo, const git_oid& id, Signature& out) {
  git_blob* rawBlob = nullptr;
  if (const int error = git_blob_lookup(&rawBlob, repo, &id); error != 0) return error;
  std::unique_ptr<git_blob, decltype(&git_blob_free)> blob(rawBlob, git_blob_free);
  out.size = static_cast<std::uint64_t>(git_blob_rawsize(blob.get()));
  return git_hashsig_create(&out.hashsig, static_cast<const char*>(git_blob_rawcontent(blob.get())),
                            static_cast<std::size_t>(out.size),
                            static_cast<git_hashsig_option_t>(GIT_HASHSIG_SMART_WHITESPACE |
                                                              GIT_HASHSIG_ALLOW_SMALL_FILES));
}

// Whether identical content may pair a source with a destination: two
// regular files whatever their executable bits, anything else (a symlink, a
// submodule) only with the same mode, as git requires.
bool identicalPairAllowed(std::uint32_t sourceMode, std::uint32_t destinationMode) {
  return (isRegularFileMode(sourceMode) && isRegularFileMode(destinationMode)) ||
         sourceMode == destinationMode;
}

// What rename detection paired in a tree diff, per delta.
struct Pairing {
  // For a destination (an added file): the source delta it takes its
  // content from, or -1.
  std::vector<std::ptrdiff_t> sourceOf;
  // For a destination: the source's content is identical.
  std::vector<bool> exact;
  // For a source: the destinations it feeds, plus one for a modified file,
  // which stays where it is. A deleted file that feeds several destinations
  // is renamed into the last of them and copied into the others.
  std::vector<int> uses;
};

// Pairs added files (destinations) with deleted files (sources; modified and
// retyped files too when detecting copies) the way git's rename detection
// does for porcelain diffs:
//  1. identical content: each destination takes a source with the same
//     blob, preferring an unused one with the same base name;
//  2. renames only: a remaining source and destination that are the only
//     ones with their base name pair when at least kBaseNameThreshold
//     similar;
//  3. unless the remaining sources times destinations exceed the limit
//     squared, every remaining destination keeps its best few sources at or
//     above the threshold (sizes too far apart to reach it are not
//     compared), and pairs are assigned best score first, a same-named
//     source winning a tie: unused sources first, then, for copies, any.
// Only regular files are compared by content; a file whose blob cannot be
// read takes no part in that.
class RenameDetector {
 public:
  RenameDetector(git_repository* repo, git_diff* diff, const RenameRules& rules,
                 const CancelToken& token, const std::function<bool()>& fetchMissing)
      : repo_(repo), diff_(diff), rules_(rules), token_(token), fetchMissing_(fetchMissing) {}

  Pairing run() {
    const std::size_t count = git_diff_num_deltas(diff_);
    pairing_.sourceOf.assign(count, -1);
    pairing_.exact.assign(count, false);
    pairing_.uses.assign(count, 0);
    if (!rules_.renames) return std::move(pairing_);
    signatures_.resize(count);
    signAttempted_.assign(count, false);
    for (std::size_t i = 0; i < count; ++i) {
      switch (git_diff_get_delta(diff_, i)->status) {
        case GIT_DELTA_ADDED:
          destinations_.push_back(i);
          break;
        case GIT_DELTA_DELETED:
          sources_.push_back(i);
          break;
        case GIT_DELTA_MODIFIED:
        case GIT_DELTA_TYPECHANGE:
          if (rules_.copies) {
            sources_.push_back(i);
            pairing_.uses[i] = 1;
          }
          break;
        default:
          break;
      }
    }
    if (sources_.empty() || destinations_.empty()) return std::move(pairing_);
    pairIdentical();
    if (!rules_.copies) pairUniqueBaseNames();
    pairSimilar();
    return std::move(pairing_);
  }

 private:
  const git_diff_file& oldFile(std::size_t delta) const {
    return git_diff_get_delta(diff_, delta)->old_file;
  }
  const git_diff_file& newFile(std::size_t delta) const {
    return git_diff_get_delta(diff_, delta)->new_file;
  }

  void pair(std::size_t source, std::size_t destination, bool exact) {
    pairing_.sourceOf[destination] = static_cast<std::ptrdiff_t>(source);
    pairing_.exact[destination] = exact;
    ++pairing_.uses[source];
  }

  void pairIdentical() {
    std::unordered_map<git_oid, std::vector<std::size_t>, OidHash, OidEqual> sourcesById;
    for (const std::size_t s : sources_) sourcesById[oldFile(s).id].push_back(s);
    for (const std::size_t d : destinations_) {
      const git_diff_file& target = newFile(d);
      const auto it = sourcesById.find(target.id);
      if (it == sourcesById.end()) continue;
      const std::string_view name = baseName(target.path);
      std::ptrdiff_t best = -1;
      int bestScore = -1;
      int alternatives = 100;  // git settles for the best of this many
      for (const std::size_t s : it->second) {
        const git_diff_file& source = oldFile(s);
        if (!identicalPairAllowed(source.mode, target.mode)) continue;
        const bool used = pairing_.uses[s] > 0;
        if (used && !rules_.copies) continue;
        const int score = (used ? 0 : 1) + (baseName(source.path) == name ? 1 : 0);
        if (score > bestScore) {
          best = static_cast<std::ptrdiff_t>(s);
          bestScore = score;
          if (score == 2) break;
        }
        if (--alternatives == 0) break;
      }
      if (best >= 0) pair(static_cast<std::size_t>(best), d, true);
    }
  }

  void pairUniqueBaseNames() {
    // Base name -> delta, or -1 for a name more than one file has.
    std::unordered_map<std::string_view, std::ptrdiff_t> sourceByName;
    std::unordered_map<std::string_view, std::ptrdiff_t> destinationByName;
    const auto record = [](auto& byName, std::string_view name, std::size_t delta) {
      const auto [it, inserted] = byName.emplace(name, static_cast<std::ptrdiff_t>(delta));
      if (!inserted) it->second = -1;
    };
    for (const std::size_t s : sources_) {
      if (pairing_.uses[s] == 0) record(sourceByName, baseName(oldFile(s).path), s);
    }
    for (const std::size_t d : destinations_) {
      if (pairing_.sourceOf[d] < 0) record(destinationByName, baseName(newFile(d).path), d);
    }
    for (const auto& [name, source] : sourceByName) {
      if (source < 0) continue;
      const auto destination = destinationByName.find(name);
      if (destination == destinationByName.end() || destination->second < 0) continue;
      token_.throwIfCancelled();
      const auto s = static_cast<std::size_t>(source);
      const auto d = static_cast<std::size_t>(destination->second);
      if (similarity(s, d, kBaseNameThreshold) >= kBaseNameThreshold) pair(s, d, false);
    }
  }

  void pairSimilar() {
    std::vector<std::size_t> sources;
    std::vector<std::size_t> destinations;
    for (const std::size_t s : sources_) {
      if (rules_.copies || pairing_.uses[s] == 0) sources.push_back(s);
    }
    for (const std::size_t d : destinations_) {
      if (pairing_.sourceOf[d] < 0) destinations.push_back(d);
    }
    if (sources.empty() || destinations.empty()) return;
    // A limit past 2^32 cannot be reached; it also keeps the square in range.
    const auto limit = static_cast<std::uint64_t>(rules_.limit);
    if (limit != 0 && limit < (std::uint64_t{1} << 32) &&
        static_cast<std::uint64_t>(sources.size()) * destinations.size() > limit * limit) {
      return;
    }

    struct Match {
      int score;
      bool sameName;
      std::size_t destination;  // delta index
      std::size_t source;       // delta index
    };
    constexpr std::size_t kCandidatesPerDestination = 4;
    const auto better = [](const Match& a, const Match& b) {
      if (a.score != b.score) return a.score > b.score;
      if (a.sameName != b.sameName) return a.sameName;
      if (a.destination != b.destination) return a.destination < b.destination;
      return a.source < b.source;
    };
    std::vector<Match> matches;
    for (const std::size_t d : destinations) {
      token_.throwIfCancelled();
      if (!signature(d, newFile(d))) continue;
      const std::string_view name = baseName(newFile(d).path);
      std::vector<Match> best;
      for (const std::size_t s : sources) {
        const int score = similarity(s, d, kRenameThreshold);
        if (score < kRenameThreshold) continue;
        const Match match{score, baseName(oldFile(s).path) == name, d, s};
        if (best.size() < kCandidatesPerDestination) {
          best.push_back(match);
          std::sort(best.begin(), best.end(), better);
        } else if (better(match, best.back())) {
          best.back() = match;
          std::sort(best.begin(), best.end(), better);
        }
      }
      matches.insert(matches.end(), best.begin(), best.end());
    }

    std::sort(matches.begin(), matches.end(), better);
    for (const bool reuse : {false, true}) {
      if (reuse && !rules_.copies) break;
      for (const Match& match : matches) {
        if (pairing_.sourceOf[match.destination] >= 0) continue;
        if (!reuse && pairing_.uses[match.source] > 0) continue;
        pair(match.source, match.destination, false);
      }
    }
  }

  // Similarity in percent of a source's old content and a destination's new
  // content; -1 when either is not a regular file or cannot be read, or when
  // their sizes are too far apart for them to be `threshold` similar.
  int similarity(std::size_t source, std::size_t destination, int threshold) {
    const Signature* from = signature(source, oldFile(source));
    const Signature* to = signature(destination, newFile(destination));
    if (!from || !to) return -1;
    const std::uint64_t larger = std::max(from->size, to->size);
    const std::uint64_t smaller = std::min(from->size, to->size);
    if ((larger - smaller) * 100 > larger * static_cast<std::uint64_t>(100 - threshold)) return -1;
    return git_hashsig_compare(from->hashsig, to->hashsig);
  }

  // The signature of `file`, the side of `delta` taking part, signed once.
  const Signature* signature(std::size_t delta, const git_diff_file& file) {
    if (!isRegularFileMode(file.mode)) return nullptr;
    if (!signAttempted_[delta]) {
      signAttempted_[delta] = true;
      token_.throwIfCancelled();
      Signature signature;
      int error = signBlob(repo_, file.id, signature);
      if (error == GIT_ENOTFOUND && fetchMissing_()) error = signBlob(repo_, file.id, signature);
      if (error == 0 && signature.hashsig) signatures_[delta].emplace(std::move(signature));
    }
    return signatures_[delta] ? &*signatures_[delta] : nullptr;
  }

  git_repository* repo_;
  git_diff* diff_;
  const RenameRules& rules_;
  const CancelToken& token_;
  const std::function<bool()>& fetchMissing_;
  std::vector<std::size_t> sources_;       // in path order
  std::vector<std::size_t> destinations_;  // in path order
  Pairing pairing_;
  std::vector<std::optional<Signature>> signatures_;
  std::vector<bool> signAttempted_;
};

}  // namespace

Result<std::vector<TreeFileChange>> treeFileChanges(const core::Repo& repo, git_tree* oldTree,
                                                    git_tree* newTree, const CancelToken& token,
                                                    std::size_t limit, std::size_t& total,
                                                    bool mayFetch) {
  git_diff_options opts;
  git_diff_options_init(&opts, GIT_DIFF_OPTIONS_VERSION);
  // A path that turns from a file into a symlink or a submodule (or back) is
  // one retyped entry, as git lists it, not a deletion plus an addition.
  opts.flags |= GIT_DIFF_INCLUDE_TYPECHANGE;
  git_diff* rawDiff = nullptr;
  if (git_diff_tree_to_tree(&rawDiff, repo.raw(), oldTree, newTree, &opts) != 0) {
    return core::gitError("diff trees");
  }
  core::DiffPtr diff(rawDiff);
  const RenameRules rules = renameRules(repo.raw());

  // A partial clone may lack blobs the similarity pass or the line stats
  // read. One plumbing diff of the same trees makes git download every blob
  // the comparison needs in a single request to the promisor remote; it is
  // tried at most once per call.
  const bool canFetch = mayFetch && isPartialClone(repo.raw());
  bool fetchTried = false;
  const std::function<bool()> fetchMissing = [&]() -> bool {
    if (!canFetch || fetchTried) return false;
    fetchTried = true;
    static const char* const kEmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const std::string from = oldTree ? core::oidToHex(*git_tree_id(oldTree)) : kEmptyTree;
    const std::string to = newTree ? core::oidToHex(*git_tree_id(newTree)) : kEmptyTree;
    auto fetched = fetchThroughGit(
        repo, {"diff-tree", "-r", "--numstat", "-z", "--no-renames", from, to}, token);
    if (!fetched) spdlog::warn("could not fetch missing blobs: {}", fetched.error().message);
    return fetched.ok();
  };

  const std::size_t count = git_diff_num_deltas(diff.get());
  const Pairing pairing = RenameDetector(repo.raw(), diff.get(), rules, token, fetchMissing).run();

  // Uses left per source, to tell a rename from a copy: a deleted file is
  // renamed into the last destination it feeds and copied into the others.
  std::vector<int> usesLeft = pairing.uses;
  std::vector<PlannedChange> planned;
  planned.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff.get(), i);
    if (delta->status == GIT_DELTA_DELETED && pairing.uses[i] > 0) {
      continue;  // listed as the source of a rename
    }
    PlannedChange change;
    change.index = i;
    change.file.path = delta->new_file.path ? delta->new_file.path : "";
    change.file.status = statusLetter(delta->status);
    if (pairing.sourceOf[i] >= 0) {
      const auto sourceIndex = static_cast<std::size_t>(pairing.sourceOf[i]);
      const git_diff_delta* source = git_diff_get_delta(diff.get(), sourceIndex);
      change.file.status = --usesLeft[sourceIndex] > 0 ? 'C' : 'R';
      change.file.origPath = source->old_file.path ? source->old_file.path : "";
      if (pairing.exact[i]) {
        change.unchangedContent = true;
      } else {
        change.fromSides = true;
        change.oldId = source->old_file.id;
        change.newId = delta->new_file.id;
      }
    } else if (delta->status == GIT_DELTA_TYPECHANGE) {
      // libgit2 loads no content for a retyped entry; git counts the lines of
      // the old content against the new.
      change.fromSides = true;
      change.oldId = delta->old_file.id;
      change.newId = delta->new_file.id;
      change.oldMode = delta->old_file.mode;
      change.newMode = delta->new_file.mode;
    }
    planned.push_back(std::move(change));
  }

  total = planned.size();
  const std::size_t listed = std::min(total, limit);
  std::vector<TreeFileChange> files;
  files.reserve(listed);
  for (std::size_t i = 0; i < listed; ++i) {
    token.throwIfCancelled();
    PlannedChange& change = planned[i];
    int error = fillStats(repo.raw(), diff.get(), change);
    if (error == GIT_ENOTFOUND && fetchMissing()) error = fillStats(repo.raw(), diff.get(), change);
    if (error != 0) {
      change.file.statsUnavailable = true;
      change.file.binary = false;
      change.file.additions = 0;
      change.file.deletions = 0;
    }
    files.push_back(std::move(change.file));
  }
  return files;
}

Result<std::vector<TreeFileChange>> commitFileChanges(const core::Repo& repo, git_commit* commit,
                                                      const CancelToken& token, std::size_t limit,
                                                      std::size_t& total, bool mayFetch) {
  auto tree = commitTree(commit);
  if (!tree) return tree.error();

  core::TreePtr parentTree;
  if (git_commit_parentcount(commit) > 0) {
    git_commit* rawParent = nullptr;
    if (git_commit_parent(&rawParent, commit, 0) != 0) {
      return core::gitError("lookup parent of " + core::oidToHex(*git_commit_id(commit)));
    }
    core::CommitPtr parent(rawParent);
    auto parentTreeResult = commitTree(parent.get());
    if (!parentTreeResult) return parentTreeResult.error();
    parentTree = std::move(parentTreeResult.value());
  }
  return treeFileChanges(repo, parentTree.get(), tree.value().get(), token, limit, total, mayFetch);
}

Result<core::DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path, bool staged) {
  git_diff_options opts;
  git_diff_options_init(&opts, GIT_DIFF_OPTIONS_VERSION);
  char* pathspec[] = {const_cast<char*>(path.c_str())};
  opts.pathspec.strings = pathspec;
  opts.pathspec.count = 1;
  opts.flags |= GIT_DIFF_DISABLE_PATHSPEC_MATCH;

  git_diff* rawDiff = nullptr;
  if (staged) {
    core::ObjectPtr treeGuard;
    git_tree* tree = nullptr;
    auto head = repo.head();
    if (!head) return head.error();
    if (!head.value().unborn) {
      git_object* rawTree = nullptr;
      if (git_revparse_single(&rawTree, repo.raw(), "HEAD^{tree}") != 0) {
        return core::gitError("resolve HEAD tree");
      }
      treeGuard.reset(rawTree);
      tree = reinterpret_cast<git_tree*>(rawTree);
    }
    if (git_diff_tree_to_index(&rawDiff, repo.raw(), tree, nullptr, &opts) != 0) {
      return core::gitError("diff HEAD..index for '" + path + "'");
    }
  } else {
    opts.flags |= GIT_DIFF_INCLUDE_UNTRACKED | GIT_DIFF_SHOW_UNTRACKED_CONTENT |
                  GIT_DIFF_RECURSE_UNTRACKED_DIRS;
    if (git_diff_index_to_workdir(&rawDiff, repo.raw(), nullptr, &opts) != 0) {
      return core::gitError("diff index..workdir for '" + path + "'");
    }
  }
  return core::DiffPtr(rawDiff);
}

const git_diff_delta* deltaForPath(git_diff* diff, const std::string& path, size_t* index) {
  const size_t count = git_diff_num_deltas(diff);
  for (size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    const char* name = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
    if (name && path == name) {
      if (index) *index = i;
      return delta;
    }
  }
  return nullptr;
}

std::string PathFilter::describe() const {
  std::string text;
  if (!driver.empty()) text = "the '" + driver + "' filter";
  if (!encoding.empty()) {
    if (!text.empty()) text += " and ";
    text += "working-tree-encoding " + encoding;
  }
  return text;
}

PathFilter pathFilter(git_repository* repo, const std::string& path) {
  PathFilter filter;
  filter.driver = stringAttribute(repo, path, "filter");
  // Git skips the conversion when the declared encoding is already UTF-8.
  std::string encoding = stringAttribute(repo, path, "working-tree-encoding");
  const std::string folded = lowercase(encoding);
  if (folded != "utf-8" && folded != "utf8") filter.encoding = std::move(encoding);
  return filter;
}

Result<core::IndexPtr> readIndex(git_repository* repo) {
  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo) != 0) return core::gitError("open index");
  core::IndexPtr index(rawIndex);
  if (git_index_read(index.get(), /*force=*/0) != 0) return core::gitError("read index");
  return index;
}

bool skipWorktree(git_index* index, const char* path) {
  const git_index_entry* entry = git_index_get_bypath(index, path, 0);
  return entry && (entry->flags_extended & GIT_INDEX_ENTRY_SKIP_WORKTREE) != 0;
}

bool workdirHas(const core::Repo& repo, const std::string& path) {
  std::error_code ec;
  const auto status =
      std::filesystem::symlink_status(pathFromUtf8(repo.workdir()) / pathFromUtf8(path), ec);
  return status.type() != std::filesystem::file_type::not_found;
}

bool indexHas(git_index* index, const std::string& path) {
  for (int stage = 0; stage <= 3; ++stage) {
    if (git_index_get_bypath(index, path.c_str(), stage)) return true;
  }
  size_t position = 0;
  return git_index_find_prefix(&position, index, (path + "/").c_str()) == 0;
}

bool workdirSideHidden(git_index* index, const git_status_entry& entry) {
  const git_diff_delta* delta = entry.index_to_workdir;
  if (!delta) return false;
  const char* path = delta->old_file.path ? delta->old_file.path : delta->new_file.path;
  if (path && index && skipWorktree(index, path)) return true;
  // A dirty submodule carries its checked-out commit as the new id; when that
  // is still the recorded commit, only the submodule's own tree changed.
  return (entry.status & GIT_STATUS_WT_MODIFIED) != 0 &&
         delta->old_file.mode == GIT_FILEMODE_COMMIT &&
         delta->new_file.mode == GIT_FILEMODE_COMMIT && !git_oid_is_zero(&delta->new_file.id) &&
         git_oid_equal(&delta->old_file.id, &delta->new_file.id);
}

bool needsCleanRecheck(git_repository* repo, const git_status_entry& entry) {
  const git_diff_delta* delta = entry.index_to_workdir;
  if (!delta || (entry.status & GIT_STATUS_WT_MODIFIED) == 0 || !delta->new_file.path) {
    return false;
  }
  if (!isRegularFileMode(delta->old_file.mode) || !isRegularFileMode(delta->new_file.mode)) {
    return false;
  }
  // A changed executable bit is a change whatever the content, and the
  // recheck compares content only.
  if (delta->old_file.mode != delta->new_file.mode) return false;
  return pathFilter(repo, delta->new_file.path).any();
}

namespace {

// What a cleaned hash depends on besides the file's bytes, which stand in for
// them: the file's size and mtime, and how the path is filtered.
struct CleanStamp {
  std::uintmax_t size = 0;
  std::filesystem::file_time_type::rep mtime = 0;
  std::string filter;

  bool operator==(const CleanStamp&) const = default;
};

// `git hash-object` results for working-tree files git cleans before it
// compares them, so that polling a repository with large Git LFS or
// git-crypt files does not run their clean filter on every status. An entry
// holds while the file's size, mtime and filter attributes stay the same.
// Thread-safe and bounded; shared by every repository in the process.
class CleanHashCache {
 public:
  std::optional<std::string> get(const std::string& key, const CleanStamp& stamp) {
    std::lock_guard lock(mutex_);
    const auto it = entries_.find(key);
    if (it == entries_.end() || !(it->second.first == stamp)) return std::nullopt;
    return it->second.second;
  }

  void put(const std::string& key, CleanStamp stamp, std::string id) {
    std::lock_guard lock(mutex_);
    if (entries_.size() >= kMaxEntries && entries_.find(key) == entries_.end()) entries_.clear();
    entries_[key] = {std::move(stamp), std::move(id)};
  }

 private:
  static constexpr std::size_t kMaxEntries = 4096;
  std::mutex mutex_;
  std::map<std::string, std::pair<CleanStamp, std::string>> entries_;
};

CleanHashCache& cleanHashCache() {
  static CleanHashCache cache;
  return cache;
}

// A file modified within this long of being hashed may change again without
// its mtime moving (coarse filesystem timestamps), so its hash is not kept.
constexpr auto kRacyWindow = std::chrono::seconds(3);

}  // namespace

std::vector<bool> confirmCleanChanges(const core::Repo& repo,
                                      const std::vector<CleanRecheck>& candidates,
                                      const CancelToken& token) {
  std::vector<bool> changed(candidates.size(), true);
  const auto startedAt = std::filesystem::file_time_type::clock::now();

  // Candidates whose cleaned hash is still known need no git run.
  std::vector<size_t> pending;
  std::vector<std::optional<CleanStamp>> stamps(candidates.size());
  std::vector<std::string> keys(candidates.size());
  for (size_t i = 0; i < candidates.size(); ++i) {
    const auto file = pathFromUtf8(repo.workdir()) / pathFromUtf8(candidates[i].path);
    std::error_code ec;
    const auto size = std::filesystem::file_size(file, ec);
    std::error_code timeEc;
    const auto mtime = std::filesystem::last_write_time(file, timeEc);
    keys[i] = repo.gitdir() + '\n' + candidates[i].path;
    if (!ec && !timeEc) {
      stamps[i] = CleanStamp{size, mtime.time_since_epoch().count(),
                             pathFilter(repo.raw(), candidates[i].path).describe()};
      if (const auto known = cleanHashCache().get(keys[i], *stamps[i])) {
        changed[i] = *known != core::oidToHex(candidates[i].indexId);
        continue;
      }
      if (startedAt - mtime < kRacyWindow) stamps[i].reset();
    }
    pending.push_back(i);
  }

  std::vector<std::string> paths;
  paths.reserve(pending.size());
  for (const size_t i : pending) paths.push_back(candidates[i].path);

  size_t offset = 0;
  for (auto& batch : argvBatches(paths)) {
    const size_t size = batch.size();
    std::vector<std::string> args = {"hash-object", "--"};
    for (auto& path : batch) args.push_back(std::move(path));
    std::vector<std::string> ids;
    auto status =
        exec::runGit(repo.workdir(), std::move(args), {}, token, [&ids](std::string line) {
          if (!line.empty() && line.back() == '\r') line.pop_back();
          ids.push_back(std::move(line));
        });
    if (status && status.value().exitCode == 0 && ids.size() == size) {
      for (size_t j = 0; j < size; ++j) {
        const size_t i = pending[offset + j];
        changed[i] = ids[j] != core::oidToHex(candidates[i].indexId);
        if (stamps[i]) cleanHashCache().put(keys[i], *stamps[i], ids[j]);
      }
    }
    offset += size;
  }
  return changed;
}

std::string runGitChecked(const core::Repo& repo, std::vector<std::string> args,
                          const CancelToken& token, const std::string& what, int alsoOk,
                          std::chrono::milliseconds timeout) {
  exec::RunOpts opts;
  opts.rawOutput = true;
  opts.timeout = timeout;
  std::string output;
  auto status = exec::runGit(repo.workdir(), std::move(args), opts, token,
                             [&output](std::string chunk) { output = std::move(chunk); });
  if (!status) throw rpc::HandlerError{{status.error()}};
  const int code = status.value().exitCode;
  if (code != 0 && code != alsoOk) {
    throw rpc::HandlerError{{ErrorCode::GitError, what + " failed (" + std::to_string(code) +
                                                      "): " + status.value().stderrText}};
  }
  return output;
}

std::vector<std::vector<std::string>> argvBatches(const std::vector<std::string>& paths) {
  std::vector<std::vector<std::string>> batches;
  size_t used = kArgvBudget;
  for (const auto& path : paths) {
    // Quotes and a separating space on top of the path itself.
    const size_t cost = path.size() + 3;
    if (batches.empty() || (used + cost > kArgvBudget && !batches.back().empty())) {
      batches.emplace_back();
      used = 0;
    }
    batches.back().push_back(path);
    used += cost;
  }
  return batches;
}

void splitPatch(const std::string& text, std::string& header, std::vector<HunkBlock>& blocks) {
  size_t pos = 0;
  while (pos < text.size()) {
    size_t eol = text.find('\n', pos);
    const size_t lineEnd = eol == std::string::npos ? text.size() : eol + 1;
    std::string line = text.substr(pos, lineEnd - pos);
    std::string bare = line;
    while (!bare.empty() && (bare.back() == '\n' || bare.back() == '\r')) bare.pop_back();
    HunkBlock parsed;
    if (parseHunkHeader(bare, parsed)) {
      parsed.headerLine = std::move(line);
      blocks.push_back(std::move(parsed));
    } else if (blocks.empty()) {
      header += line;
    } else {
      blocks.back().body += line;
    }
    pos = lineEnd;
  }
}

FilePatch filePatch(const core::Repo& repo, const std::string& path, bool staged, bool cliAvailable,
                    const CancelToken& token) {
  FilePatch patch;
  if (!staged) {
    // Git treats a skip-worktree entry as unchanged whatever the working
    // tree holds, so the absent file of an out-of-cone entry is no deletion.
    auto index = readIndex(repo.raw());
    if (!index) throw rpc::HandlerError{{index.error()}};
    if (skipWorktree(index.value().get(), path.c_str())) return patch;
  }
  auto diff = singleFileDiff(repo, path, staged);
  if (!diff) throw rpc::HandlerError{{diff.error()}};
  size_t index = 0;
  const git_diff_delta* delta = deltaForPath(diff.value().get(), path, &index);
  if (!delta) return patch;
  if (delta->old_file.mode == GIT_FILEMODE_COMMIT || delta->new_file.mode == GIT_FILEMODE_COMMIT) {
    patch.gitlink = true;
    return patch;
  }
  patch.filter = pathFilter(repo.raw(), path);

  // Both sides of a staged diff are blobs git already stores, so only the
  // working-tree side ever needs cleaning.
  if (!staged && patch.filter.any()) {
    if (!cliAvailable) {
      throw rpc::HandlerError{
          {ErrorCode::FilterNeedsGitCli,
           "'" + path + "' goes through " + patch.filter.describe() +
               ", which only the git CLI can apply, and this engine has no git CLI"}};
    }
    // A new file has no index side; --no-index against /dev/null still runs
    // the clean filter on it and yields a patch `git apply --cached` accepts.
    const bool untracked = delta->status == GIT_DELTA_UNTRACKED;
    std::vector<std::string> args = untracked
                                        ? std::vector<std::string>{"diff", "--no-index"}
                                        : std::vector<std::string>{"--literal-pathspecs", "diff"};
    // Pinned output options: the patch is parsed and re-applied, so user
    // configuration (external diff tools, textconv, colour, prefixes,
    // context size) must not reshape it.
    for (const char* arg : {"--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
                            "--src-prefix=a/", "--dst-prefix=b/", "-U3", "--"}) {
      args.emplace_back(arg);
    }
    if (untracked) args.emplace_back("/dev/null");
    args.push_back(path);
    // `git diff --no-index` exits 1 when the inputs differ.
    patch.text = runGitChecked(repo, std::move(args), token, "git diff", untracked ? 1 : 0);
    patch.viaCli = true;
    return patch;
  }

  git_patch* rawPatch = nullptr;
  if (git_patch_from_diff(&rawPatch, diff.value().get(), index) != 0) {
    throw rpc::HandlerError{{core::gitError("build patch for '" + path + "'")}};
  }
  if (!rawPatch) return patch;  // unchanged
  core::PatchPtr owned(rawPatch);
  core::BufDisposer buf;
  if (git_patch_to_buf(&buf.buf, owned.get()) != 0) {
    throw rpc::HandlerError{{core::gitError("format patch for '" + path + "'")}};
  }
  patch.text.assign(buf.buf.ptr, buf.buf.size);
  return patch;
}

}  // namespace gg::services::status_detail
