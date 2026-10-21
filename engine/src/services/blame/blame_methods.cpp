#include "services/blame/blame_methods.h"

#include <algorithm>

#include "services/params.h"

namespace gg::services {

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
        // A repository with no commits has nothing to attribute; git would
        // fail resolving HEAD, and its message is not a protocol error.
        auto head = repo.value().head();
        if (!head) throw rpc::HandlerError{{head.error()}};
        if (head.value().unborn && !request.rev) {
          return {{"streamId", streamId},
                  {"totalLines", 0},
                  {"fromCache", false},
                  {"commits", rpc::Json::object()}};
        }
        // Working-tree blame respects unsaved editor contents when pushed.
        if (!request.rev) {
          if (auto doc = context.docOverlay.get(repoId, request.path)) {
            request.contents = std::move(doc->contents);
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
        return {{"streamId", streamId},
                {"totalLines", totalLines},
                {"fromCache", summary.value().fromCache},
                {"commits", commits}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
