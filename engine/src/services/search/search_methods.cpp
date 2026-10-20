#include "services/search/search_methods.h"

#include <git2.h>

#include <cctype>
#include <cstdint>
#include <regex>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "core/git2_json.h"
#include "exec/git_runner.h"
#include "services/params.h"

namespace gg::services {

namespace {

constexpr size_t kMatchBatch = 100;

// ISO 8601 date, or date and time with an optional UTC offset; mirrors the
// IsoDate pattern of the protocol schema.
const std::regex& isoDatePattern() {
  static const std::regex pattern(
      R"(^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?)?$)");
  return pattern;
}

// Validates an optional date criterion and spells it for --since/--until.
// git reads a bare date as that day at the current time of day, so a bare
// date is pinned to the start of the day.
std::string gitDate(const rpc::Json& query, const char* key) {
  std::string value = optionalString(query, key);
  if (value.empty()) return value;
  if (!std::regex_match(value, isoDatePattern())) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams,
                             std::string("'") + key + "' must be an ISO 8601 date or date-time"}};
  }
  if (value.size() == 10) value += "T00:00:00";
  return value;
}

bool isFullSha(const std::string& line) {
  if (line.size() != GIT_OID_HEXSZ) return false;
  for (const char c : line) {
    if (!std::isxdigit(static_cast<unsigned char>(c))) return false;
  }
  return true;
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

}  // namespace

std::string caseInsensitiveLiteralPattern(std::string_view needle) {
  std::string pattern;
  pattern.reserve(needle.size() * 4);
  for (const char c : needle) {
    const auto byte = static_cast<unsigned char>(c);
    if (byte < 0x80 && std::isalpha(byte)) {
      pattern += '[';
      pattern += static_cast<char>(std::tolower(byte));
      pattern += static_cast<char>(std::toupper(byte));
      pattern += ']';
    } else if (c == '.' || c == '[' || c == '\\' || c == '*' || c == '^' || c == '$') {
      pattern += '\\';
      pattern += c;
    } else {
      pattern += c;
    }
  }
  return pattern;
}

void registerSearchMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "search/log",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn& notify) -> rpc::Json {
        requireGitCli(context);
        const std::int64_t limit = pageLimit(params);
        const std::string streamId = requireString(params, "streamId");
        const rpc::Json query = optionalObject(params, "query");
        const std::string text = optionalString(query, "text");
        const std::string author = optionalString(query, "author");
        const std::string content = optionalString(query, "content");
        const std::string contentMode = optionalString(query, "contentMode");
        if (!contentMode.empty() && contentMode != "string" && contentMode != "regex") {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'contentMode' must be 'string' or 'regex'"}};
        }
        const std::string path = optionalString(query, "path");
        const std::string since = gitDate(query, "since");
        const std::string until = gitDate(query, "until");

        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        auto head = repo.value().head();
        if (head.ok() && head.value().unborn) {
          return {{"streamId", streamId}, {"total", 0}, {"truncated", false}};
        }

        // One record past the limit proves the search was cut short. Every
        // value is attached to its option or follows "--", so none can be
        // read as another option. --basic-regexp overrides grep.patternType,
        // and --no-follow and --no-show-signature keep log.follow and
        // log.showSignature from changing what is printed.
        std::vector<std::string> args = {
            "log",         "--format=%H",    "--no-show-signature",
            "--no-follow", "--basic-regexp", "--max-count=" + std::to_string(limit + 1)};
        if (!text.empty()) args.push_back("--grep=" + caseInsensitiveLiteralPattern(text));
        if (!author.empty()) args.push_back("--author=" + caseInsensitiveLiteralPattern(author));
        if (!content.empty()) args.push_back((contentMode == "regex" ? "-G" : "-S") + content);
        if (!since.empty()) args.push_back("--since=" + since);
        if (!until.empty()) args.push_back("--until=" + until);
        args.push_back("HEAD");
        args.push_back("--");
        if (!path.empty()) args.push_back(path);

        exec::RunOpts opts;
        // In a partial clone the pickaxe would download every blob it
        // compares; reading only what is already local keeps a search from
        // turning into a fetch of the whole history. Git before 2.44 (unless
        // patched) ignores GIT_NO_LAZY_FETCH, so its lazy fetch is refused
        // by allowing it no transport.
        if (!content.empty()) {
          opts.extraEnv.push_back("GIT_NO_LAZY_FETCH=1");
          opts.extraEnv.push_back("GIT_ALLOW_PROTOCOL=none");
        }

        std::int64_t total = 0;
        bool truncated = false;
        rpc::Json batch = rpc::Json::array();
        auto flush = [&] {
          if (batch.empty()) return;
          notify("search/matches", {{"streamId", streamId}, {"matches", std::move(batch)}});
          batch = rpc::Json::array();
        };
        std::string lookupFailure;
        const std::string cwd =
            repo.value().workdir().empty() ? repo.value().gitdir() : repo.value().workdir();
        auto status = exec::runGit(cwd, std::move(args), opts, token, [&](std::string line) {
          if (!lookupFailure.empty() || !isFullSha(line)) return;
          if (total >= limit) {
            truncated = true;
            return;
          }
          git_oid oid;
          git_commit* rawCommit = nullptr;
          if (git_oid_fromstr(&oid, line.c_str()) != 0 ||
              git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            lookupFailure = line;
            return;
          }
          core::CommitPtr commit(rawCommit);
          batch.push_back(commitSummaryJson(commit.get(), line));
          ++total;
          if (batch.size() >= kMatchBatch) flush();
        });
        if (!status) throw rpc::HandlerError{{status.error()}};
        if (!lookupFailure.empty()) {
          throw rpc::HandlerError{{core::gitError("lookup commit " + lookupFailure)}};
        }
        if (status.value().exitCode != 0) {
          // A blob that is not on disk: git 2.44 and later say they could
          // not fetch it from the promisor remote; older ones, patched or
          // not, that lazy fetching is disabled or the transport not allowed.
          const std::string& stderrText = status.value().stderrText;
          const bool missingBlob = stderrText.find("promisor remote") != std::string::npos ||
                                   stderrText.find("lazy fetching disabled") != std::string::npos ||
                                   (stderrText.find("transport '") != std::string::npos &&
                                    stderrText.find("' not allowed") != std::string::npos);
          if (!content.empty() && missingBlob) {
            throw rpc::HandlerError{
                {ErrorCode::GitError,
                 "this repository is a partial clone without all of its file contents on disk, "
                 "and a code-change search does not download them; message, author, file and "
                 "date criteria still work"}};
          }
          throw rpc::HandlerError{
              {ErrorCode::GitError, "git log failed (" + std::to_string(status.value().exitCode) +
                                        "): " + status.value().stderrText}};
        }
        flush();
        return {{"streamId", streamId}, {"total", total}, {"truncated", truncated}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
