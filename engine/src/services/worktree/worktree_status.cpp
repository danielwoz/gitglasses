#include "services/worktree/worktree_status.h"

#include <git2.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <system_error>
#include <utility>

#include "core/git2.h"
#include "exec/git_runner.h"
#include "services/mutate/mutate_common.h"
#include "services/status/diff_common.h"
#include "util/temp_file.h"
#include "util/utf8_path.h"

namespace gg::services::worktree {

namespace fs = std::filesystem;

namespace {

// Most conflicted paths a status reports; the count of the rest is lost, the
// flag is not.
constexpr std::size_t kMaxConflicts = 50;

// Commits ahead of the base whose trailers are read for an agent.
constexpr int kMaxTrailerCommits = 50;

// Longest agent name kept from a free-form trailer.
constexpr std::size_t kMaxAgentName = 32;

bool startsWith(std::string_view text, std::string_view prefix) {
  return text.substr(0, prefix.size()) == prefix;
}

bool endsWith(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

std::string lower(std::string_view text) {
  std::string out(text);
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

std::string_view trim(std::string_view text) {
  const auto first = text.find_first_not_of(" \t\r\n");
  if (first == std::string_view::npos) return {};
  const auto last = text.find_last_not_of(" \t\r\n");
  return text.substr(first, last - first + 1);
}

// A path without trailing separators, with forward slashes throughout.
std::string withoutTrailingSlash(std::string path) {
  while (path.size() > 1 && (path.back() == '/' || path.back() == '\\')) path.pop_back();
  return path;
}

std::vector<std::string_view> pathSegments(std::string_view path, std::string& storage) {
  storage = std::string(path);
  std::replace(storage.begin(), storage.end(), '\\', '/');
  std::vector<std::string_view> segments;
  std::string_view rest(storage);
  while (!rest.empty()) {
    const auto slash = rest.find('/');
    const std::string_view segment = rest.substr(0, slash);
    if (!segment.empty()) segments.push_back(segment);
    if (slash == std::string_view::npos) break;
    rest.remove_prefix(slash + 1);
  }
  return segments;
}

// An agent identity in a Co-authored-by trailer, recognised by its address:
// people share names with agents ("Claude", "Jules"), but not addresses.
std::optional<std::string> agentFromAddress(std::string_view address) {
  const std::string email = lower(address);
  if (endsWith(email, "@anthropic.com")) return "Claude Code";
  if (endsWith(email, "@cursor.com")) return "Cursor";
  if (email.find("copilot") != std::string::npos) return "Copilot";
  if (endsWith(email, "@openai.com")) return "Codex";
  if (endsWith(email, "@aider.chat")) return "Aider";
  if (email.find("gemini-code-assist") != std::string::npos) return "Gemini";
  if (email.find("google-labs-jules") != std::string::npos) return "Jules";
  return std::nullopt;
}

// An agent a trailer names outright ("Assisted-by: Claude Code:model").
std::optional<std::string> agentFromName(std::string_view name) {
  const std::string lowered = lower(name);
  static constexpr std::array<std::pair<std::string_view, std::string_view>, 7> kKnown = {{
      {"claude", "Claude Code"},
      {"cursor", "Cursor"},
      {"copilot", "Copilot"},
      {"codex", "Codex"},
      {"aider", "Aider"},
      {"gemini", "Gemini"},
      {"jules", "Jules"},
  }};
  for (const auto& [prefix, agent] : kKnown) {
    if (startsWith(lowered, prefix)) return std::string(agent);
  }
  if (name.empty() || name.size() > kMaxAgentName) return std::nullopt;
  if (!std::isalnum(static_cast<unsigned char>(name.front()))) return std::nullopt;
  for (const char c : name) {
    const bool plain = std::isalnum(static_cast<unsigned char>(c)) || c == ' ' || c == '.' ||
                       c == '_' || c == '+' || c == '-';
    if (!plain) return std::nullopt;
  }
  return std::string(name);
}

// Seconds since the epoch of a file time. file_time_type's epoch is
// unspecified (and differs between standard libraries), so the offset is
// taken against both clocks' present.
std::int64_t unixSeconds(fs::file_time_type time) {
  const auto offset = time - fs::file_time_type::clock::now();
  const auto system = std::chrono::system_clock::now() +
                      std::chrono::duration_cast<std::chrono::system_clock::duration>(offset);
  return std::chrono::duration_cast<std::chrono::seconds>(system.time_since_epoch()).count();
}

// The newest of the index's modification time and the latest HEAD reflog
// entry: when someone last staged, committed or switched in the worktree.
std::optional<std::int64_t> lastActivity(git_repository* raw) {
  std::optional<std::int64_t> newest;
  const auto consider = [&newest](std::int64_t time) {
    if (!newest || time > *newest) newest = time;
  };
  if (const char* gitdir = git_repository_path(raw)) {
    std::error_code ec;
    const auto modified = fs::last_write_time(util::pathFromUtf8(gitdir) / "index", ec);
    if (!ec) consider(unixSeconds(modified));
  }
  git_reflog* rawLog = nullptr;
  if (git_reflog_read(&rawLog, raw, "HEAD") == 0) {
    std::unique_ptr<git_reflog, decltype(&git_reflog_free)> reflog(rawLog, git_reflog_free);
    if (git_reflog_entrycount(reflog.get()) > 0) {
      const git_reflog_entry* entry = git_reflog_entry_byindex(reflog.get(), 0);
      if (const git_signature* who = entry ? git_reflog_entry_committer(entry) : nullptr) {
        consider(static_cast<std::int64_t>(who->when.time));
      }
    }
  }
  return newest;
}

// Paths with uncommitted changes, each counted once whatever its state:
// staged, unstaged, untracked or conflicted, as status/summary lists them.
std::int64_t uncommittedCount(const core::Repo& repo, bool cliAvailable, const CancelToken& token) {
  git_repository* raw = repo.raw();
  git_status_options opts;
  git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
  opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS;
  git_status_list* rawList = nullptr;
  if (git_status_list_new(&rawList, raw, &opts) != 0) {
    throw rpc::HandlerError{{core::gitError("read worktree status")}};
  }
  core::StatusListPtr list(rawList);
  auto index = status_detail::readIndex(raw);
  if (!index) throw rpc::HandlerError{{index.error()}};

  constexpr unsigned kStaged = GIT_STATUS_INDEX_NEW | GIT_STATUS_INDEX_MODIFIED |
                               GIT_STATUS_INDEX_DELETED | GIT_STATUS_INDEX_RENAMED |
                               GIT_STATUS_INDEX_TYPECHANGE;
  constexpr unsigned kUnstaged = GIT_STATUS_WT_MODIFIED | GIT_STATUS_WT_DELETED |
                                 GIT_STATUS_WT_RENAMED | GIT_STATUS_WT_TYPECHANGE;
  std::int64_t count = 0;
  // Files whose only change is libgit2's raw-bytes verdict on a filtered
  // file; git cleans them first and often finds them unchanged.
  std::vector<status_detail::CleanRecheck> rechecks;
  const size_t entries = git_status_list_entrycount(list.get());
  for (size_t i = 0; i < entries; ++i) {
    token.throwIfCancelled();
    const git_status_entry* entry = git_status_byindex(list.get(), i);
    if (!entry) continue;
    const unsigned flags = entry->status;
    if ((flags & (GIT_STATUS_CONFLICTED | GIT_STATUS_WT_NEW | kStaged)) != 0) {
      ++count;
      continue;
    }
    const git_diff_delta* wtDelta = entry->index_to_workdir;
    if (!wtDelta || (flags & kUnstaged) == 0) continue;
    if (status_detail::workdirSideHidden(index.value().get(), *entry)) continue;
    if ((flags & GIT_STATUS_WT_MODIFIED) && cliAvailable &&
        status_detail::needsCleanRecheck(raw, *entry)) {
      rechecks.push_back(
          {wtDelta->new_file.path ? wtDelta->new_file.path : "", wtDelta->old_file.id});
      continue;
    }
    ++count;
  }
  if (!rechecks.empty()) {
    for (const bool changed : status_detail::confirmCleanChanges(repo, rechecks, token)) {
      if (changed) ++count;
    }
  }
  return count;
}

// C-style quoting git reads back from GIT_ALTERNATE_OBJECT_DIRECTORIES, so a
// path holding the list separator (':' or ';') or a quote stays one entry.
std::string quoteAlternate(const std::string& path) {
  std::string out = "\"";
  for (const char c : path) {
    const auto byte = static_cast<unsigned char>(c);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (byte < 0x20 || byte == 0x7f) {
      char escaped[5];
      std::snprintf(escaped, sizeof escaped, "\\%03o", byte);
      out += escaped;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

// A temporary object directory that receives the objects a command writes,
// with the repository's own database as its alternate for everything it
// reads, so the command leaves the repository as it found it.
class ObjectQuarantine {
 public:
  explicit ObjectQuarantine(const std::string& objectsDir) {
    for (int attempt = 0; attempt < 4 && dir_.empty(); ++attempt) {
      fs::path candidate = util::randomTempPath("gg-objects-", "");
      std::error_code ec;
      if (fs::create_directory(candidate, ec)) dir_ = std::move(candidate);
    }
    if (dir_.empty()) return;
    env_ = {"GIT_OBJECT_DIRECTORY=" + util::utf8FromPath(dir_),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES=" + quoteAlternate(objectsDir)};
  }
  ~ObjectQuarantine() {
    if (dir_.empty()) return;
    std::error_code ec;
    fs::remove_all(dir_, ec);
  }
  ObjectQuarantine(const ObjectQuarantine&) = delete;
  ObjectQuarantine& operator=(const ObjectQuarantine&) = delete;

  bool ready() const { return !dir_.empty(); }
  const std::vector<std::string>& environment() const { return env_; }

 private:
  fs::path dir_;
  std::vector<std::string> env_;
};

struct MergeCheck {
  std::optional<bool> clean;
  // Why `clean` is unknown: restricted, noGitCli, gitVersion, partialClone,
  // failed.
  std::string skipped;
  std::vector<std::string> conflicts;
};

// Whether `head` merges into `base` without conflicts, decided by `git
// merge-tree --write-tree` (git 2.38+), which merges in memory: no checkout,
// no index, and the objects it writes go to a quarantine.
MergeCheck checkMerge(const core::Repo& repo, const git_oid& base, const git_oid& head,
                      std::size_t ahead, std::size_t behind, const StatusRequest& request,
                      const CancelToken& token) {
  // Nothing to merge, or a fast-forward: clean without asking git.
  if (ahead == 0 || behind == 0) return {true, {}, {}};
  if (request.restricted) return {std::nullopt, "restricted", {}};
  if (!request.cliAvailable) return {std::nullopt, "noGitCli", {}};
  if (!request.gitVersion || !request.gitVersion->atLeast(2, 38)) {
    return {std::nullopt, "gitVersion", {}};
  }
  // A partial clone fetches missing blobs on demand; GIT_NO_LAZY_FETCH
  // stops that from 2.45 on, and a status read must not reach the network.
  if (status_detail::isPartialClone(repo.raw()) && !request.gitVersion->atLeast(2, 45)) {
    return {std::nullopt, "partialClone", {}};
  }
  const char* common = git_repository_commondir(repo.raw());
  ObjectQuarantine quarantine(
      util::utf8FromPath(util::pathFromUtf8(common ? common : "") / "objects"));
  if (!quarantine.ready()) {
    spdlog::warn("worktree/status: no temporary object directory for the merge check");
    return {std::nullopt, "failed", {}};
  }
  exec::RunOpts opts;
  opts.rawOutput = true;
  opts.extraEnv = quarantine.environment();
  opts.extraEnv.push_back("GIT_NO_LAZY_FETCH=1");
  std::string output;
  auto run = exec::runGit(mutate_detail::repoCwd(repo),
                          {"merge-tree", "--write-tree", "--name-only", "--no-messages", "-z",
                           core::oidToHex(base), core::oidToHex(head)},
                          opts, token, [&output](std::string chunk) { output += chunk; });
  if (!run) {
    spdlog::warn("worktree/status: git merge-tree did not run: {}", run.error().message);
    return {std::nullopt, "failed", {}};
  }
  if (run.value().exitCode == 0) return {true, {}, {}};
  if (run.value().exitCode == 1) return {false, {}, mergeTreeConflicts(output, kMaxConflicts)};
  spdlog::warn("worktree/status: git merge-tree failed ({}): {}", run.value().exitCode,
               run.value().stderrText);
  return {std::nullopt, "failed", {}};
}

// The agent the trailers of the commits in base..head declare, newest first.
std::optional<std::string> agentFromCommits(git_repository* raw, const git_oid& base,
                                            const git_oid& head, const CancelToken& token) {
  git_revwalk* rawWalk = nullptr;
  if (git_revwalk_new(&rawWalk, raw) != 0) return std::nullopt;
  std::unique_ptr<git_revwalk, decltype(&git_revwalk_free)> walk(rawWalk, git_revwalk_free);
  git_revwalk_sorting(walk.get(), GIT_SORT_TIME);
  if (git_revwalk_push(walk.get(), &head) != 0 || git_revwalk_hide(walk.get(), &base) != 0) {
    return std::nullopt;
  }
  git_oid oid;
  for (int seen = 0; seen < kMaxTrailerCommits && git_revwalk_next(&oid, walk.get()) == 0; ++seen) {
    token.throwIfCancelled();
    git_commit* rawCommit = nullptr;
    if (git_commit_lookup(&rawCommit, raw, &oid) != 0) continue;
    core::CommitPtr commit(rawCommit);
    git_message_trailer_array trailers = {};
    if (git_message_trailers(&trailers, git_commit_message(commit.get())) != 0) continue;
    std::optional<std::string> found;
    for (std::size_t i = 0; i < trailers.count && !found; ++i) {
      const git_message_trailer& trailer = trailers.trailers[i];
      found = agentFromTrailer(trailer.key ? trailer.key : "", trailer.value ? trailer.value : "");
    }
    git_message_trailer_array_free(&trailers);
    if (found) return found;
  }
  return std::nullopt;
}

// The default base: the branch checked out in the main worktree, or the
// branch HEAD names in a bare repository. Empty when that HEAD is detached or
// has no commits yet.
std::string defaultBase(const core::Repo& repo) {
  const char* common = git_repository_commondir(repo.raw());
  if (!common) return {};
  auto main = core::Repo::open(common);
  if (!main) return {};
  auto head = main.value().head();
  if (!head || head.value().unborn || head.value().detached) return {};
  return head.value().branch;
}

// The local branch HEAD is on, or null when it is detached or unborn.
core::ReferencePtr headBranch(git_repository* raw) {
  if (git_repository_head_detached(raw) == 1 || git_repository_head_unborn(raw) == 1) return {};
  git_reference* rawHead = nullptr;
  if (git_repository_head(&rawHead, raw) != 0) return {};
  core::ReferencePtr head(rawHead);
  if (!git_reference_is_branch(head.get())) return {};
  return head;
}

// HEAD as the worktree's administrative directory records it, for a worktree
// whose directory is gone: the branch it names (and that branch's commit), or
// the commit a detached HEAD holds.
rpc::Json recordedHead(const core::Repo& main, const std::string& name) {
  rpc::Json entry = {{"sha", ""}};
  const char* common = git_repository_commondir(main.raw());
  if (!common) return entry;
  std::ifstream in(util::pathFromUtf8(common) / "worktrees" / util::pathFromUtf8(name) / "HEAD",
                   std::ios::binary);
  std::string line;
  if (!std::getline(in, line)) return entry;
  line = std::string(trim(line));
  constexpr std::string_view kSymbolic = "ref: ";
  if (!startsWith(line, kSymbolic)) {
    git_oid oid;
    if (git_oid_fromstr(&oid, line.c_str()) == 0) entry["sha"] = core::oidToHex(oid);
    return entry;
  }
  const std::string target = line.substr(kSymbolic.size());
  constexpr std::string_view kHeads = "refs/heads/";
  if (startsWith(target, kHeads)) entry["branch"] = target.substr(kHeads.size());
  git_oid oid;
  if (git_reference_name_to_id(&oid, main.raw(), target.c_str()) == 0) {
    entry["sha"] = core::oidToHex(oid);
  }
  return entry;
}

rpc::Json headFields(const core::Repo& repo) {
  rpc::Json entry = {{"sha", ""}};
  auto head = repo.head();
  if (!head) return entry;
  entry["sha"] = head.value().oid;
  if (!head.value().detached && !head.value().branch.empty()) entry["branch"] = head.value().branch;
  return entry;
}

}  // namespace

std::optional<AgentMatch> agentFromLocation(std::string_view path, std::string_view branch) {
  std::string storage;
  const auto segments = pathSegments(path, storage);
  static constexpr std::array<std::pair<std::string_view, std::string_view>, 3> kHomes = {{
      {".claude", "Claude Code"},
      {".cursor", "Cursor"},
      {".codex", "Codex"},
  }};
  for (size_t i = 0; i + 2 < segments.size(); ++i) {
    if (segments[i + 1] != "worktrees") continue;
    for (const auto& [home, agent] : kHomes) {
      if (segments[i] == home) return AgentMatch{std::string(agent), "path"};
    }
  }
  const std::string_view name = segments.empty() ? std::string_view() : segments.back();
  if (segments.size() >= 2 && endsWith(segments[segments.size() - 2], ".worktrees")) {
    if (startsWith(name, "copilot-worktree-")) return AgentMatch{"Copilot", "path"};
    if (startsWith(name, "agents-")) return AgentMatch{"VS Code agent", "path"};
  }

  // `claude --worktree <name>` names its branch worktree-<name>.
  if (startsWith(branch, "worktree-") && !name.empty() && branch.substr(9) == name) {
    return AgentMatch{"Claude Code", "branch"};
  }
  if (startsWith(branch, "copilot-worktree-")) return AgentMatch{"Copilot", "branch"};
  static constexpr std::array<std::pair<std::string_view, std::string_view>, 4> kPrefixes = {{
      {"claude/", "Claude Code"},
      {"cursor/", "Cursor"},
      {"codex/", "Codex"},
      {"copilot/", "Copilot"},
  }};
  for (const auto& [prefix, agent] : kPrefixes) {
    if (startsWith(branch, prefix) && branch.size() > prefix.size()) {
      return AgentMatch{std::string(agent), "branch"};
    }
  }
  return std::nullopt;
}

std::optional<std::string> agentFromTrailer(std::string_view key, std::string_view value) {
  const std::string name = lower(trim(key));
  if (name == "co-authored-by") {
    const auto open = value.find('<');
    const auto close = value.find('>', open == std::string_view::npos ? 0 : open);
    if (open == std::string_view::npos || close == std::string_view::npos) return std::nullopt;
    return agentFromAddress(trim(value.substr(open + 1, close - open - 1)));
  }
  if (name == "assisted-by" || name == "generated-by") {
    const auto end = value.find_first_of(":<(");
    return agentFromName(trim(value.substr(0, end)));
  }
  return std::nullopt;
}

std::vector<std::string> mergeTreeConflicts(std::string_view output, std::size_t limit) {
  std::vector<std::string> paths;
  bool first = true;
  while (!output.empty() && paths.size() < limit) {
    const auto nul = output.find('\0');
    const std::string_view field = output.substr(0, nul);
    // The first field is the id of the merged tree.
    if (!first && !field.empty() && std::find(paths.begin(), paths.end(), field) == paths.end()) {
      paths.emplace_back(field);
    }
    first = false;
    if (nul == std::string_view::npos) break;
    output.remove_prefix(nul + 1);
  }
  return paths;
}

bool isRepoDirectory(const core::Repo& repo, const std::string& path) {
  std::error_code ec;
  const bool same = fs::equivalent(util::pathFromUtf8(path),
                                   util::pathFromUtf8(mutate_detail::repoCwd(repo)), ec);
  return same && !ec;
}

rpc::Json listWithLibgit2(const core::Repo& repo) {
  rpc::Json worktrees = rpc::Json::array();
  const char* common = git_repository_commondir(repo.raw());
  auto main = core::Repo::open(common ? common : repo.gitdir());
  if (!main) throw rpc::HandlerError{{main.error()}};

  const auto entry = [&repo](const core::Repo& opened, std::string path, bool bare, bool locked,
                             bool prunable) {
    rpc::Json item = bare ? rpc::Json{{"sha", ""}} : headFields(opened);
    item["path"] = withoutTrailingSlash(std::move(path));
    item["bare"] = bare;
    item["locked"] = locked;
    item["prunable"] = prunable;
    item["current"] = isRepoDirectory(repo, item["path"].get<std::string>());
    return item;
  };
  const core::Repo& primary = main.value();
  worktrees.push_back(entry(primary, primary.isBare() ? primary.gitdir() : primary.workdir(),
                            primary.isBare(), false, false));

  git_strarray names = {};
  if (git_worktree_list(&names, primary.raw()) != 0) {
    throw rpc::HandlerError{{core::gitError("list worktrees")}};
  }
  std::unique_ptr<git_strarray, decltype(&git_strarray_dispose)> namesGuard(&names,
                                                                            git_strarray_dispose);
  std::vector<rpc::Json> linked;
  for (size_t i = 0; i < names.count; ++i) {
    git_worktree* rawWorktree = nullptr;
    if (git_worktree_lookup(&rawWorktree, primary.raw(), names.strings[i]) != 0) continue;
    std::unique_ptr<git_worktree, decltype(&git_worktree_free)> worktree(rawWorktree,
                                                                         git_worktree_free);
    const char* path = git_worktree_path(worktree.get());
    if (!path) continue;
    const bool locked = git_worktree_is_locked(nullptr, worktree.get()) > 0;
    const bool prunable = git_worktree_validate(worktree.get()) != 0;
    auto opened = prunable ? Result<core::Repo>(Error{ErrorCode::RepoNotFound, "missing"})
                           : core::Repo::open(path);
    if (opened) {
      linked.push_back(entry(opened.value(), path, false, locked, prunable));
      continue;
    }
    rpc::Json item = recordedHead(primary, names.strings[i]);
    item["path"] = withoutTrailingSlash(path);
    item["bare"] = false;
    item["locked"] = locked;
    item["prunable"] = prunable;
    item["current"] = false;
    linked.push_back(std::move(item));
  }
  std::sort(linked.begin(), linked.end(), [](const rpc::Json& a, const rpc::Json& b) {
    return a["path"].get<std::string>() < b["path"].get<std::string>();
  });
  for (auto& item : linked) worktrees.push_back(std::move(item));
  return worktrees;
}

rpc::Json status(const core::Repo& repo, const StatusRequest& request, const CancelToken& token) {
  auto opened = core::Repo::open(request.path);
  if (!opened) {
    throw rpc::HandlerError{{ErrorCode::RepoNotFound,
                             "no worktree at " + request.path + ": " + opened.error().message}};
  }
  const core::Repo& tree = opened.value();
  // Only a worktree of this repository shares its object database and refs.
  std::error_code ec;
  const char* ownCommon = git_repository_commondir(repo.raw());
  const char* treeCommon = git_repository_commondir(tree.raw());
  if (!ownCommon || !treeCommon ||
      !fs::equivalent(util::pathFromUtf8(ownCommon), util::pathFromUtf8(treeCommon), ec) || ec) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, request.path + " is not a worktree of this repository"}};
  }

  rpc::Json result = {{"path", request.path}};
  if (!tree.isBare()) result["dirty"] = uncommittedCount(tree, request.cliAvailable, token);
  if (const auto when = lastActivity(tree.raw())) result["lastActivity"] = *when;

  auto head = tree.head();
  if (!head) throw rpc::HandlerError{{head.error()}};
  const std::string branch = head.value().detached ? std::string() : head.value().branch;

  git_oid headOid = {};
  const bool hasCommit =
      !head.value().unborn && git_oid_fromstr(&headOid, head.value().oid.c_str()) == 0;

  if (core::ReferencePtr local = headBranch(tree.raw())) {
    git_reference* rawUpstream = nullptr;
    if (git_branch_upstream(&rawUpstream, local.get()) == 0) {
      core::ReferencePtr upstream(rawUpstream);
      const git_oid* upstreamOid = git_reference_target(upstream.get());
      size_t ahead = 0, behind = 0;
      if (upstreamOid && hasCommit &&
          git_graph_ahead_behind(&ahead, &behind, tree.raw(), &headOid, upstreamOid) == 0) {
        const char* name = git_reference_shorthand(upstream.get());
        result["upstream"] = {{"ref", name ? name : ""}, {"ahead", ahead}, {"behind", behind}};
      }
    }
  }

  std::optional<std::string> trailerAgent;
  const std::string baseRev = request.base.empty() ? defaultBase(repo) : request.base;
  if (!baseRev.empty() && hasCommit) {
    auto baseCommit = status_detail::resolveCommit(repo, baseRev);
    if (!baseCommit) {
      if (!request.base.empty()) {
        throw rpc::HandlerError{
            {ErrorCode::InvalidParams, "base '" + request.base + "' names no commit"}};
      }
    } else {
      const git_oid baseOid = *git_commit_id(baseCommit.value().get());
      size_t ahead = 0, behind = 0;
      if (git_graph_ahead_behind(&ahead, &behind, repo.raw(), &headOid, &baseOid) != 0) {
        throw rpc::HandlerError{{core::gitError("count commits against " + baseRev)}};
      }
      rpc::Json base = {
          {"ref", baseRev}, {"sha", core::oidToHex(baseOid)}, {"ahead", ahead}, {"behind", behind}};
      git_oid mergeBase;
      if (git_merge_base(&mergeBase, repo.raw(), &headOid, &baseOid) == 0) {
        base["mergeBase"] = core::oidToHex(mergeBase);
      }
      const MergeCheck merge = checkMerge(repo, baseOid, headOid, ahead, behind, request, token);
      base["mergesCleanly"] = merge.clean ? rpc::Json(*merge.clean) : rpc::Json(nullptr);
      if (!merge.skipped.empty()) base["mergeSkipped"] = merge.skipped;
      if (merge.clean == false) base["conflicts"] = merge.conflicts;
      result["base"] = std::move(base);
      if (ahead > 0) trailerAgent = agentFromCommits(repo.raw(), baseOid, headOid, token);
    }
  }

  std::optional<AgentMatch> agent = agentFromLocation(request.path, branch);
  // A path that only says "an agent session in VS Code" names the host, not
  // the agent; a trailer names the agent itself.
  if (trailerAgent && (!agent || agent->evidence != "path" || agent->name == "VS Code agent")) {
    agent = AgentMatch{*trailerAgent, "trailer"};
  }
  if (agent) result["agent"] = {{"name", agent->name}, {"evidence", agent->evidence}};
  return result;
}

}  // namespace gg::services::worktree
