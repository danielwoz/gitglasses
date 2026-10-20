#include "services/status/diff_common.h"

#include <git2/sys/hashsig.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <memory>
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
  std::size_t limit = 1000;  // git's default diff.renameLimit
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
    // git reads zero or a negative limit as its own maximum.
    rules.limit = limit > 0 ? static_cast<std::size_t>(limit) : 32767;
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
// tree diff, or, for a rename paired by similarity, the two blobs. An exact
// rename changes no line; only its binary verdict is looked up.
struct PlannedChange {
  TreeFileChange file;
  std::size_t index = 0;
  bool unchangedContent = false;
  bool fromBlobs = false;
  git_oid oldId{};
  git_oid newId{};
};

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
    return unchangedContentStats(repo, git_diff_get_delta(diff, change.index)->new_file.id, file);
  }
  git_patch* rawPatch = nullptr;
  if (change.fromBlobs) {
    git_blob* rawOld = nullptr;
    git_blob* rawNew = nullptr;
    if (const int error = git_blob_lookup(&rawOld, repo, &change.oldId); error != 0) return error;
    std::unique_ptr<git_blob, decltype(&git_blob_free)> oldBlob(rawOld, git_blob_free);
    if (const int error = git_blob_lookup(&rawNew, repo, &change.newId); error != 0) return error;
    std::unique_ptr<git_blob, decltype(&git_blob_free)> newBlob(rawNew, git_blob_free);
    if (const int error = git_patch_from_blobs(&rawPatch, oldBlob.get(), file.origPath.c_str(),
                                               newBlob.get(), file.path.c_str(), nullptr);
        error != 0) {
      return error;
    }
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

// Pairs exact renames in `diff` by blob id: each added regular file takes a
// deleted regular file with the same content, preferring one with the same
// base name, as git does. Returns, per delta, the index of the deleted file
// an addition was paired with (or -1), and marks paired deletions.
std::vector<std::ptrdiff_t> pairExactRenames(git_diff* diff, std::vector<bool>& pairedSource) {
  const std::size_t count = git_diff_num_deltas(diff);
  std::vector<std::ptrdiff_t> sourceOf(count, -1);
  pairedSource.assign(count, false);
  std::unordered_map<git_oid, std::vector<std::size_t>, OidHash, OidEqual> deletedById;
  for (std::size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    if (delta->status == GIT_DELTA_DELETED && isRegularFileMode(delta->old_file.mode)) {
      deletedById[delta->old_file.id].push_back(i);
    }
  }
  if (deletedById.empty()) return sourceOf;
  for (std::size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    if (delta->status != GIT_DELTA_ADDED || !isRegularFileMode(delta->new_file.mode)) continue;
    const auto it = deletedById.find(delta->new_file.id);
    if (it == deletedById.end()) continue;
    const std::string_view name = baseName(delta->new_file.path);
    std::ptrdiff_t chosen = -1;
    for (const std::size_t candidate : it->second) {
      if (pairedSource[candidate]) continue;
      if (chosen < 0) chosen = static_cast<std::ptrdiff_t>(candidate);
      if (baseName(git_diff_get_delta(diff, candidate)->old_file.path) == name) {
        chosen = static_cast<std::ptrdiff_t>(candidate);
        break;
      }
    }
    if (chosen < 0) continue;
    pairedSource[static_cast<std::size_t>(chosen)] = true;
    sourceOf[i] = chosen;
  }
  return sourceOf;
}

// Minimum similarity (percent) for an inexact rename, git's default -M50%.
constexpr int kRenameThreshold = 50;

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

// Pairs deletions with additions by content similarity the way git's rename
// detection does: every destination keeps its best few sources at or above
// the threshold (sizes too far apart to reach it are not compared), then the
// pairs are assigned greedily, best score first, a same-named source winning
// a tie, each file used once. Files whose blob cannot be read take no part.
// Returns (source delta, destination delta) pairs.
std::vector<std::pair<std::size_t, std::size_t>> pairSimilarRenames(
    git_repository* repo, git_diff* diff, const std::vector<std::size_t>& sources,
    const std::vector<std::size_t>& destinations, const CancelToken& token,
    const std::function<bool()>& fetchMissing) {
  const auto sign = [&](const git_oid& id, Signature& out) {
    int error = signBlob(repo, id, out);
    if (error == GIT_ENOTFOUND && fetchMissing()) error = signBlob(repo, id, out);
    return error == 0 && out.hashsig != nullptr;
  };
  std::vector<Signature> sourceSigs(sources.size());
  std::vector<bool> sourceSigned(sources.size(), false);
  for (std::size_t s = 0; s < sources.size(); ++s) {
    token.throwIfCancelled();
    sourceSigned[s] = sign(git_diff_get_delta(diff, sources[s])->old_file.id, sourceSigs[s]);
  }

  struct Match {
    int score;
    bool sameName;
    std::size_t destination;  // index into `destinations`
    std::size_t source;       // index into `sources`
  };
  constexpr std::size_t kCandidatesPerDestination = 4;
  const auto better = [](const Match& a, const Match& b) {
    if (a.score != b.score) return a.score > b.score;
    if (a.sameName != b.sameName) return a.sameName;
    if (a.destination != b.destination) return a.destination < b.destination;
    return a.source < b.source;
  };
  std::vector<Match> matches;
  for (std::size_t d = 0; d < destinations.size(); ++d) {
    token.throwIfCancelled();
    const git_diff_delta* target = git_diff_get_delta(diff, destinations[d]);
    Signature targetSig;
    if (!sign(target->new_file.id, targetSig)) continue;
    const std::string_view name = baseName(target->new_file.path);
    std::vector<Match> best;
    for (std::size_t s = 0; s < sources.size(); ++s) {
      if (!sourceSigned[s]) continue;
      const std::uint64_t larger = std::max(sourceSigs[s].size, targetSig.size);
      const std::uint64_t smaller = std::min(sourceSigs[s].size, targetSig.size);
      if ((larger - smaller) * 100 > larger * (100 - kRenameThreshold)) continue;
      const int score = git_hashsig_compare(sourceSigs[s].hashsig, targetSig.hashsig);
      if (score < kRenameThreshold) continue;
      const Match match{
          score, baseName(git_diff_get_delta(diff, sources[s])->old_file.path) == name, d, s};
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
  std::vector<bool> sourceTaken(sources.size(), false);
  std::vector<bool> destinationTaken(destinations.size(), false);
  std::vector<std::pair<std::size_t, std::size_t>> pairs;
  for (const Match& match : matches) {
    if (sourceTaken[match.source] || destinationTaken[match.destination]) continue;
    sourceTaken[match.source] = true;
    destinationTaken[match.destination] = true;
    pairs.emplace_back(sources[match.source], destinations[match.destination]);
  }
  return pairs;
}

}  // namespace

Result<std::vector<TreeFileChange>> treeFileChanges(const core::Repo& repo, git_tree* oldTree,
                                                    git_tree* newTree, const CancelToken& token,
                                                    std::size_t limit, std::size_t& total,
                                                    bool mayFetch) {
  git_diff* rawDiff = nullptr;
  if (git_diff_tree_to_tree(&rawDiff, repo.raw(), oldTree, newTree, nullptr) != 0) {
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

  if (rules.copies) {
    // Copy detection needs every modified file as a candidate source;
    // libgit2 pairs renames and copies in one pass.
    git_diff_find_options findOpts;
    git_diff_find_options_init(&findOpts, GIT_DIFF_FIND_OPTIONS_VERSION);
    findOpts.flags = GIT_DIFF_FIND_RENAMES | GIT_DIFF_FIND_COPIES;
    findOpts.rename_limit = rules.limit;
    int error = git_diff_find_similar(diff.get(), &findOpts);
    if (error == GIT_ENOTFOUND && fetchMissing()) {
      error = git_diff_find_similar(diff.get(), &findOpts);
    }
    if (error != 0) return core::gitError("detect renames");
  }

  const std::size_t count = git_diff_num_deltas(diff.get());
  std::vector<bool> pairedSource(count, false);
  std::vector<std::ptrdiff_t> renameSource(count, -1);
  std::vector<bool> exact(count, false);
  if (rules.renames && !rules.copies) {
    renameSource = pairExactRenames(diff.get(), pairedSource);
    for (std::size_t i = 0; i < count; ++i) exact[i] = renameSource[i] >= 0;

    // Similarity among what exact pairing left: unpaired deletions are the
    // sources, unpaired additions the destinations. git skips this step when
    // sources x destinations exceeds the limit squared.
    std::vector<std::size_t> sources;
    std::vector<std::size_t> destinations;
    for (std::size_t i = 0; i < count; ++i) {
      const git_diff_delta* delta = git_diff_get_delta(diff.get(), i);
      if (delta->status == GIT_DELTA_DELETED && !pairedSource[i] &&
          isRegularFileMode(delta->old_file.mode)) {
        sources.push_back(i);
      } else if (delta->status == GIT_DELTA_ADDED && renameSource[i] < 0 &&
                 isRegularFileMode(delta->new_file.mode)) {
        destinations.push_back(i);
      }
    }
    const std::uint64_t candidates = static_cast<std::uint64_t>(sources.size()) *
                                     static_cast<std::uint64_t>(destinations.size());
    if (candidates > 0 && candidates <= static_cast<std::uint64_t>(rules.limit) * rules.limit) {
      for (const auto& [source, destination] :
           pairSimilarRenames(repo.raw(), diff.get(), sources, destinations, token, fetchMissing)) {
        pairedSource[source] = true;
        renameSource[destination] = static_cast<std::ptrdiff_t>(source);
      }
    }
  }

  std::vector<PlannedChange> planned;
  planned.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff.get(), i);
    if (pairedSource[i]) continue;  // listed as its rename's source
    PlannedChange change;
    change.index = i;
    change.file.path = delta->new_file.path ? delta->new_file.path : "";
    change.file.status = statusLetter(delta->status);
    if ((change.file.status == 'R' || change.file.status == 'C') && delta->old_file.path) {
      change.file.origPath = delta->old_file.path;
    }
    if (renameSource[i] >= 0) {
      const git_diff_delta* source =
          git_diff_get_delta(diff.get(), static_cast<std::size_t>(renameSource[i]));
      change.file.status = 'R';
      change.file.origPath = source->old_file.path ? source->old_file.path : "";
      if (exact[i]) {
        change.unchangedContent = true;
      } else {
        change.fromBlobs = true;
        change.oldId = source->old_file.id;
        change.newId = delta->new_file.id;
      }
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

std::vector<bool> confirmCleanChanges(const core::Repo& repo,
                                      const std::vector<CleanRecheck>& candidates,
                                      const CancelToken& token) {
  std::vector<bool> changed(candidates.size(), true);
  std::vector<std::string> paths;
  paths.reserve(candidates.size());
  for (const auto& candidate : candidates) paths.push_back(candidate.path);

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
      for (size_t i = 0; i < size; ++i) {
        changed[offset + i] = ids[i] != core::oidToHex(candidates[offset + i].indexId);
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
