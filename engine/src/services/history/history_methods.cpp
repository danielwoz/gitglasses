#include "services/history/history_methods.h"

#include <git2.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#if defined(__GLIBC__)
#include <malloc.h>
#endif

#include "core/git2.h"
#include "core/git2_json.h"
#include "exec/git_process.h"
#include "exec/git_runner.h"
#include "exec/parsers/history_log.h"
#include "services/history/log_order_cache.h"
#include "services/params.h"
#include "services/status/diff_common.h"
#include "util/sha256.h"

namespace gg::services {

namespace {

// One-line-per-commit record format shared by the CLI-backed history methods;
// HistoryLogParser is its counterpart.
constexpr const char* kLogFormat = "--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s";

struct RevwalkDeleter {
  void operator()(git_revwalk* walk) const { git_revwalk_free(walk); }
};
using RevwalkPtr = std::unique_ptr<git_revwalk, RevwalkDeleter>;

bool headUnborn(const core::Repo& repo) {
  auto head = repo.head();
  return head.ok() && head.value().unborn;
}

rpc::Json commitSummaryJson(git_commit* commit, const std::string& sha) {
  rpc::Json parents = rpc::Json::array();
  const unsigned int parentCount = git_commit_parentcount(commit);
  for (unsigned int i = 0; i < parentCount; ++i) {
    parents.push_back(core::oidToHex(*git_commit_parent_id(commit, i)));
  }
  const char* summary = git_commit_summary(commit);
  return {{"sha", sha},
          {"parents", std::move(parents)},
          {"author", core::signatureJson(git_commit_author(commit))},
          {"committer", core::signatureJson(git_commit_committer(commit))},
          {"summary", summary ? summary : ""}};
}

rpc::Json historyEntryJson(const exec::HistoryEntry& entry) {
  return {{"sha", entry.sha},
          {"author",
           {{"name", entry.author.name},
            {"email", entry.author.email},
            {"time", entry.author.time}}},
          {"summary", entry.summary},
          {"path", entry.path},
          {"additions", entry.additions},
          {"deletions", entry.deletions}};
}

// Resolves `ref` to the commit it names, peeling tags. Empty (not an error)
// when the ref is HEAD-ish and unborn, so callers answer with empty results
// instead of failing on a fresh repository.
Result<std::optional<git_oid>> resolveTip(const core::Repo& repo, const std::string& ref) {
  git_object* obj = nullptr;
  if (git_revparse_single(&obj, repo.raw(), ref.c_str()) != 0) {
    if (headUnborn(repo)) return std::optional<git_oid>{};
    return core::gitError("resolve '" + ref + "'");
  }
  core::ObjectPtr objGuard(obj);
  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, obj, GIT_OBJECT_COMMIT) != 0) {
    return core::gitError("'" + ref + "' does not point to a commit");
  }
  core::ObjectPtr peeledGuard(peeled);
  return std::optional<git_oid>{*git_object_id(peeled)};
}

// Creates a revwalk with `sorting` starting at `ref`. Returns a null walk
// (not an error) when the ref is HEAD-ish and unborn.
Result<RevwalkPtr> newWalk(const core::Repo& repo, const std::string& ref, unsigned int sorting) {
  auto tip = resolveTip(repo, ref);
  if (!tip) return tip.error();
  if (!tip.value()) return RevwalkPtr{};
  git_revwalk* rawWalk = nullptr;
  if (git_revwalk_new(&rawWalk, repo.raw()) != 0) return core::gitError("revwalk");
  RevwalkPtr walk(rawWalk);
  git_revwalk_sorting(walk.get(), sorting);
  if (git_revwalk_push(walk.get(), &*tip.value()) != 0) {
    return core::gitError("revwalk push '" + ref + "'");
  }
  return walk;
}

// Visits the commits reachable from `tip` but not from `hidden` in `sorting`
// order: what `git rev-list hidden..tip` lists.
void walkExclusive(const core::Repo& repo, const git_oid& tip, const git_oid& hidden,
                   unsigned int sorting, const CancelToken& token,
                   const std::function<void(const git_oid&)>& visit) {
  git_revwalk* rawWalk = nullptr;
  if (git_revwalk_new(&rawWalk, repo.raw()) != 0) {
    throw rpc::HandlerError{{core::gitError("revwalk")}};
  }
  RevwalkPtr walk(rawWalk);
  git_revwalk_sorting(walk.get(), sorting);
  if (git_revwalk_push(walk.get(), &tip) != 0 || git_revwalk_hide(walk.get(), &hidden) != 0) {
    throw rpc::HandlerError{
        {core::gitError("revwalk " + core::oidToHex(hidden) + ".." + core::oidToHex(tip))}};
  }
  git_oid oid;
  int status = 0;
  std::size_t visited = 0;
  while ((status = git_revwalk_next(&oid, walk.get())) == 0) {
    if ((visited++ & 0x3ff) == 0) token.throwIfCancelled();
    visit(oid);
  }
  if (status != GIT_ITEROVER) throw rpc::HandlerError{{core::gitError("revwalk")}};
}

// --- log/commits paging ------------------------------------------------------

#if defined(__GLIBC__)
// Commits sorted by one walk past which the allocator is asked to hand freed
// memory back to the system. A whole-history walk of a large repository
// allocates hundreds of megabytes on a worker thread; glibc keeps that in the
// thread's arena otherwise, and every worker ratchets up its own.
constexpr std::size_t kTrimAfterWalk = 20000;
#endif

// Contents of a file in the common dir, or "" when it does not exist.
std::string readCommonFile(const core::Repo& repo, const char* name) {
  const char* commondir = git_repository_commondir(repo.raw());
  std::ifstream in(std::filesystem::path(commondir ? commondir : repo.gitdir()) / name,
                   std::ios::binary);
  if (!in) return {};
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

// Identifies the history a tip reaches in this repository: the commit DAG
// below a commit never changes, except where the shallow boundary or grafts
// cut it.
std::string logOrderKey(const core::Repo& repo, const git_oid& tip) {
  std::string key = repo.gitdir();
  key += '\n';
  key += core::oidToHex(tip);
  const std::string cuts =
      readCommonFile(repo, "shallow") + '\0' + readCommonFile(repo, "info/grafts");
  if (cuts.size() > 1) {
    key += '\n';
    key += util::sha256Hex(cuts);
  }
  return key;
}

// Holds a sequence's lock, waiting in slices so a cancelled request stops
// waiting for another request's walk.
std::unique_lock<std::timed_mutex> lockOrder(history_detail::LogOrder& order,
                                             const CancelToken& token) {
  std::unique_lock lock(order.mutex, std::defer_lock);
  while (!lock.try_lock_for(std::chrono::milliseconds(50))) token.throwIfCancelled();
  return lock;
}

// Extends the forced run (see LogOrder) until it holds `want` commits, reaches
// a root (the run is then the whole history), or ends at a merge.
void extendRun(const core::Repo& repo, const git_oid& tip, history_detail::LogOrder& order,
               std::size_t want, const CancelToken& token) {
  if (order.oids.empty()) order.oids.push_back(tip);
  while (!order.complete && !order.runEnded && order.oids.size() < want) {
    token.throwIfCancelled();
    git_commit* rawCommit = nullptr;
    if (git_commit_lookup(&rawCommit, repo.raw(), &order.oids.back()) != 0) {
      throw rpc::HandlerError{
          {core::gitError("lookup commit " + core::oidToHex(order.oids.back()))}};
    }
    core::CommitPtr commit(rawCommit);
    const unsigned int parents = git_commit_parentcount(commit.get());
    if (parents == 0) {
      order.complete = true;
    } else if (parents > 1) {
      order.runEnded = true;
    } else {
      order.oids.push_back(*git_commit_parent_id(commit.get(), 0));
    }
  }
}

// Replaces the run with the full topological + time order of the tip's
// history. The walk sorts everything before yielding the first commit.
void completeOrder(const core::Repo& repo, const git_oid& tip, history_detail::LogOrder& order,
                   const CancelToken& token) {
  std::vector<git_oid> oids;
  {
    git_revwalk* rawWalk = nullptr;
    if (git_revwalk_new(&rawWalk, repo.raw()) != 0) {
      throw rpc::HandlerError{{core::gitError("revwalk")}};
    }
    RevwalkPtr walk(rawWalk);
    git_revwalk_sorting(walk.get(), GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);
    if (git_revwalk_push(walk.get(), &tip) != 0) {
      throw rpc::HandlerError{{core::gitError("revwalk push " + core::oidToHex(tip))}};
    }
    oids.reserve(std::max<std::size_t>(order.oids.size(), 1024));
    git_oid oid;
    int status = 0;
    while ((status = git_revwalk_next(&oid, walk.get())) == 0) {
      if ((oids.size() & 0x3ff) == 0) token.throwIfCancelled();
      oids.push_back(oid);
    }
    // A walk cut short (a missing or corrupt commit) must not be kept as the
    // whole history.
    if (status != GIT_ITEROVER) {
      throw rpc::HandlerError{{core::gitError("walk history of " + core::oidToHex(tip))}};
    }
  }
  oids.shrink_to_fit();
  order.oids = std::move(oids);
  order.complete = true;
#if defined(__GLIBC__)
  if (order.oids.size() >= kTrimAfterWalk) malloc_trim(0);
#endif
}

// "<tip sha>:<offset>": the history snapshot a page belongs to and where the
// next page starts in it.
std::string encodeLogCursor(const git_oid& tip, std::size_t offset) {
  return core::oidToHex(tip) + ":" + std::to_string(offset);
}

bool isHexSha(std::string_view text) {
  return text.size() == GIT_OID_HEXSZ &&
         text.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}

struct LogCursor {
  git_oid tip{};
  std::size_t offset = 0;
};

std::optional<LogCursor> decodeLogCursor(const std::string& cursor) {
  if (cursor.size() < GIT_OID_HEXSZ + 2 || cursor[GIT_OID_HEXSZ] != ':') return std::nullopt;
  const std::string_view sha(cursor.data(), GIT_OID_HEXSZ);
  const std::string_view digits = std::string_view(cursor).substr(GIT_OID_HEXSZ + 1);
  if (!isHexSha(sha) || digits.size() > 15 ||
      digits.find_first_not_of("0123456789") != std::string_view::npos) {
    return std::nullopt;
  }
  LogCursor decoded;
  if (git_oid_fromstrn(&decoded.tip, sha.data(), sha.size()) != 0) return std::nullopt;
  decoded.offset = static_cast<std::size_t>(std::stoull(std::string(digits)));
  return decoded;
}

// Runs `git log <args>` in the repo and feeds every stdout line through
// `parser`, failing with the process's stderr on a nonzero exit.
Result<void> runGitLog(const core::Repo& repo, std::vector<std::string> args,
                       const CancelToken& token, exec::HistoryLogParser& parser) {
  const std::string cwd = repo.workdir().empty() ? repo.gitdir() : repo.workdir();
  auto status = exec::runGit(cwd, std::move(args), {}, token,
                             [&parser](std::string line) { parser.feedLine(line); });
  if (!status) return status.error();
  parser.finish();
  if (status.value().exitCode != 0) {
    return Error{ErrorCode::GitError, "git log failed (" + std::to_string(status.value().exitCode) +
                                          "): " + status.value().stderrText};
  }
  return {};
}

char lowerByte(char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }

std::string toLower(std::string_view text) {
  std::string lowered(text);
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), lowerByte);
  return lowered;
}

// Case-insensitive substring test; `loweredNeedle` must already be lowercase.
// Lowercases the haystack one character at a time inside the search, so no
// commit message is copied.
bool containsCi(const char* haystack, std::string_view loweredNeedle) {
  if (!haystack) return false;
  const std::string_view text(haystack);
  const auto hit = std::search(text.begin(), text.end(), loweredNeedle.begin(), loweredNeedle.end(),
                               [](char a, char b) { return lowerByte(a) == b; });
  return hit != text.end();
}

}  // namespace

void registerHistoryMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Topo-ordered commit page from a ref (default HEAD). The order of a tip's
  // history is computed once and shared by every page of it (and by other
  // requests for the same tip); pages within the tip's first-parent run up
  // to its first merge never need the whole-history sort at all. The cursor
  // pins the tip the first page resolved, so later pages continue the same
  // snapshot even after the ref moves. A bare sha cursor (the next commit)
  // is still accepted and resolved against the ref's current tip.
  auto orders = std::make_shared<history_detail::LogOrderCache>();
  dispatcher.method(
      "log/commits",
      [&context, orders](const rpc::Json& params, const CancelToken& token,
                         const rpc::NotifyFn&) -> rpc::Json {
        const auto limit = static_cast<std::size_t>(pageLimit(params));
        std::string ref = optionalString(params, "ref");
        if (ref.empty()) ref = "HEAD";
        const std::string cursor = optionalString(params, "cursor");
        std::optional<LogCursor> position;
        if (!cursor.empty()) {
          position = decodeLogCursor(cursor);
          if (!position && !isHexSha(cursor)) {
            throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
          }
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        rpc::Json commits = rpc::Json::array();
        git_oid tip;
        if (position) {
          tip = position->tip;
          // A snapshot whose tip no longer exists (history rewritten and
          // collected) has nothing left to page through.
          git_commit* rawTip = nullptr;
          if (git_commit_lookup(&rawTip, repo.value().raw(), &tip) != 0) {
            return {{"commits", std::move(commits)}};
          }
          git_commit_free(rawTip);
        } else {
          auto resolved = resolveTip(repo.value(), ref);
          if (!resolved) throw rpc::HandlerError{{resolved.error()}};
          if (!resolved.value()) return {{"commits", std::move(commits)}};  // unborn HEAD
          tip = *resolved.value();
        }

        const std::string key = logOrderKey(repo.value(), tip);
        const std::shared_ptr<history_detail::LogOrder> order = orders->acquire(key);
        std::vector<git_oid> page;
        bool hasMore = false;
        std::size_t start = position ? position->offset : 0;
        {
          auto lock = lockOrder(*order, token);
          if (!cursor.empty() && !position) {
            // Legacy cursor: the sha of the next commit under the current tip.
            git_oid next;
            if (git_oid_fromstr(&next, cursor.c_str()) != 0) {
              throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
            }
            const auto findNext = [&] {
              return std::find_if(order->oids.begin(), order->oids.end(),
                                  [&](const git_oid& oid) { return git_oid_equal(&oid, &next); });
            };
            auto found = findNext();
            if (found == order->oids.end() && !order->complete) {
              completeOrder(repo.value(), tip, *order, token);
              found = findNext();
            }
            // A cursor that no longer exists (history rewritten) yields an
            // empty final page rather than an error.
            start = static_cast<std::size_t>(found - order->oids.begin());
          }
          // One past the page: knowing whether anything follows it decides
          // whether a next cursor is due.
          const std::size_t end = start + limit;
          extendRun(repo.value(), tip, *order, end + 1, token);
          if (!order->complete && order->oids.size() < end) {
            completeOrder(repo.value(), tip, *order, token);
          }
          if (start < order->oids.size()) {
            const std::size_t stop = std::min(end, order->oids.size());
            page.assign(order->oids.begin() + static_cast<std::ptrdiff_t>(start),
                        order->oids.begin() + static_cast<std::ptrdiff_t>(stop));
          }
          // An incomplete sequence ends in a commit that still has parents.
          hasMore = order->oids.size() > end || (!order->complete && order->oids.size() >= end);
          orders->resized(key, *order, order->oids.size());
        }

        for (const git_oid& oid : page) {
          token.throwIfCancelled();
          git_commit* rawCommit = nullptr;
          const std::string sha = core::oidToHex(oid);
          if (git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
          }
          core::CommitPtr commit(rawCommit);
          commits.push_back(commitSummaryJson(commit.get(), sha));
        }
        rpc::Json result = {{"commits", std::move(commits)}};
        if (hasMore) result["nextCursor"] = encodeLogCursor(tip, start + limit);
        return result;
      },
      rpc::Mode::Concurrent);

  // Two revisions compared the way `git log base..head` and `git rev-list
  // --left-right --count base...head` compare them: the merge base, the
  // commits each side has that the other lacks, and the first `limit` of
  // head's own commits in topological order. Reads through libgit2 alone.
  dispatcher.method(
      "log/compare",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const auto limit = static_cast<std::size_t>(pageLimit(params));
        const std::string base = requireString(params, "base");
        const std::string head = requireString(params, "head");
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto baseCommit = status_detail::resolveCommit(repo.value(), base);
        if (!baseCommit) throw rpc::HandlerError{{baseCommit.error()}};
        auto headCommit = status_detail::resolveCommit(repo.value(), head);
        if (!headCommit) throw rpc::HandlerError{{headCommit.error()}};
        const git_oid baseOid = *git_commit_id(baseCommit.value().get());
        const git_oid headOid = *git_commit_id(headCommit.value().get());

        rpc::Json result = {{"base", core::oidToHex(baseOid)}, {"head", core::oidToHex(headOid)}};
        git_oid mergeBase;
        const int found = git_merge_base(&mergeBase, repo.value().raw(), &baseOid, &headOid);
        if (found == 0) {
          result["mergeBase"] = core::oidToHex(mergeBase);
        } else if (found != GIT_ENOTFOUND) {
          throw rpc::HandlerError{
              {core::gitError("merge base of '" + base + "' and '" + head + "'")}};
        }

        std::vector<git_oid> page;
        std::int64_t ahead = 0;
        walkExclusive(repo.value(), headOid, baseOid, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME, token,
                      [&](const git_oid& oid) {
                        if (page.size() < limit) page.push_back(oid);
                        ++ahead;
                      });
        std::int64_t behind = 0;
        walkExclusive(repo.value(), baseOid, headOid, GIT_SORT_NONE, token,
                      [&](const git_oid&) { ++behind; });

        rpc::Json commits = rpc::Json::array();
        for (const git_oid& oid : page) {
          token.throwIfCancelled();
          const std::string sha = core::oidToHex(oid);
          git_commit* rawCommit = nullptr;
          if (git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
          }
          core::CommitPtr commit(rawCommit);
          commits.push_back(commitSummaryJson(commit.get(), sha));
        }
        result["ahead"] = ahead;
        result["behind"] = behind;
        result["commits"] = std::move(commits);
        return result;
      },
      rpc::Mode::Concurrent);

  // File history following renames, newest first. The CLI is the oracle for
  // --follow's rename detection. The cursor is "<sha>:<path at that commit>"
  // for the first entry of the next page: resuming restarts the log walk at
  // that commit with that path (`--skip` cannot be used, since git's --follow
  // machinery yields nothing once records are skipped).
  dispatcher.method(
      "history/file",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::int64_t limit = pageLimit(params);
        const std::string path = requireString(params, "path");
        std::string startRev;
        std::string startPath = path;
        if (const std::string cursor = optionalString(params, "cursor"); !cursor.empty()) {
          if (cursor.size() < GIT_OID_HEXSZ + 2 || cursor[GIT_OID_HEXSZ] != ':') {
            throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
          }
          startRev = cursor.substr(0, GIT_OID_HEXSZ);
          startPath = cursor.substr(GIT_OID_HEXSZ + 1);
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        rpc::Json entries = rpc::Json::array();
        if (headUnborn(repo.value())) return {{"entries", std::move(entries)}};

        // Fetch one extra record: its presence proves another page exists,
        // and its sha+path form that page's cursor.
        std::vector<exec::HistoryEntry> parsed;
        exec::HistoryLogParser parser(
            exec::HistoryLogParser::Stats::Numstat, startPath,
            [&parsed](const exec::HistoryEntry& entry) { parsed.push_back(entry); });
        // The path is literal: `app/[id]/page.tsx` must not match
        // `app/i/page.tsx`.
        std::vector<std::string> args = {
            "--literal-pathspecs", "log",      "--follow",
            "--numstat",           kLogFormat, "--max-count=" + std::to_string(limit + 1)};
        if (!startRev.empty()) {
          // Precedes the "--" separator; reject option-looking revs.
          if (exec::looksLikeGitOption(startRev)) {
            throw rpc::HandlerError{
                {ErrorCode::InvalidParams, "'startRev' may not begin with '-'"}};
          }
          args.push_back(startRev);
        }
        args.push_back("--");
        args.push_back(startPath);
        auto run = runGitLog(repo.value(), std::move(args), token, parser);
        if (!run) throw rpc::HandlerError{{run.error()}};

        const bool hasMore = parsed.size() > static_cast<size_t>(limit);
        std::string nextCursor;
        if (hasMore) {
          const auto& next = parsed[static_cast<size_t>(limit)];
          nextCursor = next.sha + ":" + next.path;
          parsed.resize(static_cast<size_t>(limit));
        }
        for (const auto& entry : parsed) entries.push_back(historyEntryJson(entry));
        rpc::Json result = {{"entries", std::move(entries)}};
        if (hasMore) result["nextCursor"] = nextCursor;
        return result;
      },
      rpc::Mode::Concurrent);

  // History of a line range. -L forces patch output (and rejects --no-patch
  // on older gits), so the parser simply skips every non-record line.
  dispatcher.method(
      "history/line",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string path = requireString(params, "path");
        const std::int64_t startLine =
            requireInteger(params, "startLine", 1, std::numeric_limits<std::int64_t>::max());
        const std::int64_t endLine =
            requireInteger(params, "endLine", 1, std::numeric_limits<std::int64_t>::max());
        if (endLine < startLine) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'endLine' must not be before 'startLine'"}};
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        rpc::Json entries = rpc::Json::array();
        if (headUnborn(repo.value())) return {{"entries", std::move(entries)}};

        exec::HistoryLogParser parser(
            exec::HistoryLogParser::Stats::None, path,
            [&entries](const exec::HistoryEntry& entry) {
              entries.push_back(historyEntryJson(entry));
            });
        auto run = runGitLog(repo.value(),
                             {"log",
                              "-L" + std::to_string(startLine) + "," + std::to_string(endLine) +
                                  ":" + path,
                              kLogFormat},
                             token, parser);
        if (!run) throw rpc::HandlerError{{run.error()}};
        return {{"entries", std::move(entries)}};
      },
      rpc::Mode::Concurrent);

  // Commit search over HEAD's history. Matches stream out as search/matches
  // notification batches; the result carries only the totals.
  dispatcher.method(
      "search/commits",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn& notify) -> rpc::Json {
        const std::int64_t limit = pageLimit(params);
        const std::string streamId = requireString(params, "streamId");
        const rpc::Json query = optionalObject(params, "query");
        const std::string text = toLower(optionalString(query, "text"));
        const std::string author = toLower(optionalString(query, "author"));
        const std::string shaPrefix = toLower(optionalString(query, "sha"));
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        // GIT_SORT_NONE is libgit2's "same order as git log": reverse
        // chronological, which the search parity oracle also uses.
        auto walk = newWalk(repo.value(), "HEAD", GIT_SORT_NONE);
        if (!walk) throw rpc::HandlerError{{walk.error()}};

        constexpr size_t kMatchBatch = 100;
        std::int64_t total = 0;
        bool truncated = false;
        rpc::Json batch = rpc::Json::array();
        auto flush = [&] {
          if (batch.empty()) return;
          notify("search/matches", {{"streamId", streamId}, {"matches", std::move(batch)}});
          batch = rpc::Json::array();
        };

        git_oid oid;
        while (walk.value() && git_revwalk_next(&oid, walk.value().get()) == 0) {
          token.throwIfCancelled();
          const std::string sha = core::oidToHex(oid);
          git_commit* rawCommit = nullptr;
          if (git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
          }
          core::CommitPtr commit(rawCommit);

          // Criteria AND together; an empty query matches every commit.
          bool matches = true;
          if (!text.empty()) matches = containsCi(git_commit_message(commit.get()), text);
          if (matches && !author.empty()) {
            const git_signature* sig = git_commit_author(commit.get());
            matches = sig && (containsCi(sig->name, author) || containsCi(sig->email, author));
          }
          if (matches && !shaPrefix.empty()) matches = sha.rfind(shaPrefix, 0) == 0;
          if (!matches) continue;

          batch.push_back(commitSummaryJson(commit.get(), sha));
          if (batch.size() >= kMatchBatch) flush();
          if (++total >= limit) {
            truncated = true;
            break;
          }
        }
        flush();
        return {{"streamId", streamId}, {"total", total}, {"truncated", truncated}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
