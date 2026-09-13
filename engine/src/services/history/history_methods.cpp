#include "services/history/history_methods.h"

#include <git2.h>

#include <algorithm>
#include <cctype>
#include <memory>
#include <string>
#include <vector>

#include "core/git2.h"
#include "core/git2_json.h"
#include "exec/git_process.h"
#include "exec/git_runner.h"
#include "exec/parsers/history_log.h"
#include "services/params.h"

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

// Creates a topo+time revwalk starting at `ref`. Returns a null walk (not an
// error) when the ref is HEAD-ish and unborn, so callers answer with empty
// results instead of failing on a fresh repository.
Result<RevwalkPtr> newWalk(const core::Repo& repo, const std::string& ref, unsigned int sorting) {
  git_object* obj = nullptr;
  if (git_revparse_single(&obj, repo.raw(), ref.c_str()) != 0) {
    if (headUnborn(repo)) return RevwalkPtr{};
    return core::gitError("resolve '" + ref + "'");
  }
  std::unique_ptr<git_object, decltype(&git_object_free)> objGuard(obj, git_object_free);

  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, obj, GIT_OBJECT_COMMIT) != 0) {
    return core::gitError("'" + ref + "' does not point to a commit");
  }
  std::unique_ptr<git_object, decltype(&git_object_free)> peeledGuard(peeled, git_object_free);

  git_revwalk* rawWalk = nullptr;
  if (git_revwalk_new(&rawWalk, repo.raw()) != 0) return core::gitError("revwalk");
  RevwalkPtr walk(rawWalk);
  git_revwalk_sorting(walk.get(), sorting);
  if (git_revwalk_push(walk.get(), git_object_id(peeled)) != 0) {
    return core::gitError("revwalk push '" + ref + "'");
  }
  return walk;
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
    return Error{ErrorCode::GitError, "git log failed (" +
                                          std::to_string(status.value().exitCode) + "): " +
                                          status.value().stderrText};
  }
  return {};
}

std::string toLower(std::string_view text) {
  std::string lowered(text);
  std::transform(lowered.begin(), lowered.end(), lowered.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return lowered;
}

// Case-insensitive substring test; `loweredNeedle` must already be lowercase.
bool containsCi(const char* haystack, const std::string& loweredNeedle) {
  if (!haystack) return false;
  return toLower(haystack).find(loweredNeedle) != std::string::npos;
}

}  // namespace

void registerHistoryMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Topo-ordered commit page from a ref (default HEAD). The cursor is the sha
  // of the first commit of the next page; resuming re-walks from the ref up
  // to that sha, an O(history) cost that is acceptable for v1 page sizes.
  dispatcher.method(
      "log/commits",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::int64_t limit = requireLimit(params);
        const std::string ref = params.value("ref", "HEAD");
        const std::string cursor = params.value("cursor", "");
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto walk = newWalk(repo.value(), ref, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);
        if (!walk) throw rpc::HandlerError{{walk.error()}};
        rpc::Json commits = rpc::Json::array();
        if (!walk.value()) return {{"commits", std::move(commits)}};  // unborn HEAD

        bool started = cursor.empty();
        std::optional<std::string> nextCursor;
        git_oid oid;
        while (git_revwalk_next(&oid, walk.value().get()) == 0) {
          token.throwIfCancelled();
          std::string sha = core::oidToHex(oid);
          if (!started) {
            if (sha != cursor) continue;
            started = true;
          }
          if (commits.size() >= static_cast<size_t>(limit)) {
            nextCursor = std::move(sha);
            break;
          }
          git_commit* rawCommit = nullptr;
          if (git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
          }
          core::CommitPtr commit(rawCommit);
          commits.push_back(commitSummaryJson(commit.get(), sha));
        }
        // A cursor that no longer exists (history rewritten) yields an empty
        // final page rather than an error.
        rpc::Json result = {{"commits", std::move(commits)}};
        if (nextCursor) result["nextCursor"] = *nextCursor;
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
        const std::int64_t limit = requireLimit(params);
        const std::string path = requireString(params, "path");
        std::string startRev;
        std::string startPath = path;
        if (params.contains("cursor") && params["cursor"].is_string()) {
          const std::string cursor = params["cursor"].get<std::string>();
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
        std::vector<std::string> args = {"log", "--follow", "--numstat", kLogFormat,
                                         "--max-count=" + std::to_string(limit + 1)};
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
        const std::int64_t startLine = params.value("startLine", std::int64_t{0});
        const std::int64_t endLine = params.value("endLine", std::int64_t{0});
        if (startLine < 1 || endLine < startLine) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'startLine'/'endLine' must satisfy 1 <= start <= end"}};
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
        const std::int64_t limit = requireLimit(params);
        const std::string streamId = params.value("streamId", "");
        const rpc::Json query = params.value("query", rpc::Json::object());
        const std::string text = toLower(query.value("text", ""));
        const std::string author = toLower(query.value("author", ""));
        const std::string shaPrefix = toLower(query.value("sha", ""));
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
