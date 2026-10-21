#include "services/blame/blame_methods.h"

#include <algorithm>
#include <cstdint>
#include <limits>

#include "services/params.h"

namespace gg::services {

namespace {

// The `options` param of blame/file. Absent members keep their defaults.
BlameOptions parseOptions(const rpc::Json& params) {
  const rpc::Json options = optionalObject(params, "options");
  BlameOptions parsed;
  const auto boolean = [&options](const char* key, bool fallback) {
    const auto it = options.find(key);
    if (it == options.end()) return fallback;
    if (!it->is_boolean()) {
      throw rpc::HandlerError{
          {ErrorCode::InvalidParams, std::string("'options.") + key + "' must be a boolean"}};
    }
    return it->get<bool>();
  };
  parsed.ignoreWhitespace = boolean("ignoreWhitespace", parsed.ignoreWhitespace);
  parsed.ignoreRevs = boolean("ignoreRevs", parsed.ignoreRevs);
  if (const auto it = options.find("moves"); it != options.end()) {
    const std::string moves = it->is_string() ? it->get<std::string>() : "";
    if (moves == "off") {
      parsed.moves = MoveDetection::Off;
    } else if (moves == "withinFile") {
      parsed.moves = MoveDetection::WithinFile;
    } else if (moves == "acrossFiles") {
      parsed.moves = MoveDetection::AcrossFiles;
    } else {
      throw rpc::HandlerError{
          {ErrorCode::InvalidParams,
           "'options.moves' must be one of 'off', 'withinFile', 'acrossFiles'"}};
    }
  }
  return parsed;
}

}  // namespace

void registerBlameMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "blame/file",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn& notify) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        const std::string streamId = requireString(params, "streamId");
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        BlameRequest request;
        request.path = requireString(params, "path");
        if (const std::string rev = optionalString(params, "rev"); !rev.empty()) {
          request.rev = rev;
        }
        request.options = parseOptions(params);
        // Which editor buffer the client is asking about: a document version,
        // -1 for the file on disk, or absent for whatever buffer was pushed.
        const bool versioned = params.contains("docVersion");
        const std::int64_t docVersion =
            optionalInteger(params, "docVersion", -1, std::numeric_limits<std::int64_t>::max(), -1);
        // A repository with no commits has nothing to attribute; git would
        // fail resolving HEAD, and its message is not a protocol error.
        auto head = repo.value().head();
        if (!head) throw rpc::HandlerError{{head.error()}};
        if (head.value().unborn && !request.rev) {
          // Nothing is attributed whatever the buffer holds, so the answer
          // stands for the version asked about.
          return {{"streamId", streamId},
                  {"totalLines", 0},
                  {"fromCache", false},
                  {"lfs", false},
                  {"commits", rpc::Json::object()},
                  {"docVersion", versioned ? docVersion : -1}};
        }
        // Working-tree blame respects unsaved editor contents when pushed. A
        // request for the file on disk skips the pushed buffer, which the
        // client may not have dropped yet. The method runs after every
        // doc/didChange that arrived before it, so a client that pushes a
        // version and then asks for it gets that buffer.
        std::int64_t blamedVersion = -1;
        if (!request.rev && !(versioned && docVersion < 0)) {
          if (auto doc = context.docOverlay.get(repoId, request.path)) {
            request.contents = std::move(doc->contents);
            blamedVersion = doc->version;
          }
        }

        // Hunks are batched per notification: per-hunk frames are dominated
        // by serialization overhead on fragmented histories.
        constexpr size_t kHunkBatch = 500;
        std::uint32_t totalLines = 0;
        rpc::Json batch = rpc::Json::array();
        auto flush = [&] {
          if (batch.empty()) return;
          notify("blame/hunks", {{"streamId", streamId}, {"hunks", std::move(batch)}});
          batch = rpc::Json::array();
        };
        auto summary = context.blameService.blame(
            repo.value(), request, token, [&](const exec::BlameHunk& hunk) {
              totalLines = std::max(totalLines, hunk.resultLine + hunk.lineCount - 1);
              rpc::Json hunkJson = {{"sha", hunk.sha},
                                    {"resultLine", hunk.resultLine},
                                    {"originalLine", hunk.originalLine},
                                    {"lineCount", hunk.lineCount},
                                    {"path", hunk.path}};
              if (hunk.previousSha) {
                hunkJson["previous"] = {{"sha", *hunk.previousSha}, {"path", *hunk.previousPath}};
              }
              batch.push_back(std::move(hunkJson));
              if (batch.size() >= kHunkBatch) flush();
            });
        if (!summary) throw rpc::HandlerError{{summary.error()}};
        flush();

        rpc::Json commits = rpc::Json::object();
        for (const auto& [sha, commit] : summary.value().result->commits) {
          commits[sha] = {{"author",
                           {{"name", commit.author.name},
                            {"email", commit.author.email},
                            {"time", commit.author.time}}},
                          {"committer",
                           {{"name", commit.committer.name},
                            {"email", commit.committer.email},
                            {"time", commit.committer.time}}},
                          {"summary", commit.summary},
                          {"boundary", commit.boundary}};
        }
        rpc::Json result = {{"streamId", streamId},
                            {"totalLines", totalLines},
                            {"fromCache", summary.value().fromCache},
                            {"lfs", summary.value().lfs},
                            {"commits", commits}};
        // The buffer the hunks describe, so a client can tell an answer for
        // an older (or newer) buffer from the one it asked about.
        if (!request.rev) result["docVersion"] = blamedVersion;
        return result;
      },
      rpc::Mode::AfterNotifications);
}

}  // namespace gg::services
