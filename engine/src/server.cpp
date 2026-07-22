#include "server.h"

#include <spdlog/spdlog.h>

#include <atomic>

#include "cache/blame_cache.h"
#include "cache/doc_overlay.h"
#include "core/git2.h"
#include "repo/registry.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "services/blame/blame_service.h"

namespace gg {

namespace {

constexpr const char* kProtocolVersion = "0.1.0";
constexpr const char* kEngineVersion = "0.1.0";

}  // namespace

int runServer(std::istream& in, std::ostream& out) {
  core::LibGit2 libgit2;
  rpc::FrameReader reader(in);
  rpc::FrameWriter writer(out);
  TaskPool pool;
  repo::Registry registry;
  cache::BlameCache blameCache;
  cache::DocOverlay docOverlay;
  services::BlameService blameService(blameCache);
  std::atomic<bool> shutdownRequested{false};

  rpc::Dispatcher dispatcher(pool, [&writer](const rpc::Json& message) {
    writer.write(message.dump());
  });

  dispatcher.method("initialize", [](const rpc::Json& params, const CancelToken&,
                                     const rpc::NotifyFn&) -> rpc::Json {
    const std::string clientProtocol = params.value("protocolVersion", "");
    if (clientProtocol != kProtocolVersion) {
      throw rpc::HandlerError{{ErrorCode::InvalidRequest,
                               std::string("protocol version mismatch: engine speaks ") +
                                   kProtocolVersion + ", client sent '" + clientProtocol + "'"}};
    }
    return {{"engineVersion", kEngineVersion},
            {"protocolVersion", kProtocolVersion},
            {"capabilities", rpc::Json::object()}};
  });

  dispatcher.method("shutdown", [&shutdownRequested](const rpc::Json&, const CancelToken&,
                                                     const rpc::NotifyFn&) -> rpc::Json {
    shutdownRequested = true;
    return rpc::Json::object();
  });

  dispatcher.method("repo/discover", [&registry](const rpc::Json& params, const CancelToken&,
                                                 const rpc::NotifyFn&) -> rpc::Json {
    const std::string path = params.value("path", "");
    if (path.empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' is required"}};
    }
    auto info = registry.add(path);
    if (!info) throw rpc::HandlerError{{info.error()}};
    return {{"repoId", info.value().id},
            {"rootPath", info.value().rootPath},
            {"bare", info.value().bare}};
  });

  dispatcher.method("repo/list", [&registry](const rpc::Json&, const CancelToken&,
                                             const rpc::NotifyFn&) -> rpc::Json {
    rpc::Json repos = rpc::Json::array();
    for (const auto& info : registry.list()) {
      repos.push_back({{"repoId", info.id}, {"rootPath", info.rootPath}, {"bare", info.bare}});
    }
    return {{"repos", repos}};
  });

  dispatcher.method("repo/state", [&registry](const rpc::Json& params, const CancelToken&,
                                              const rpc::NotifyFn&) -> rpc::Json {
    auto repo = registry.open(params.value("repoId", ""));
    if (!repo) throw rpc::HandlerError{{repo.error()}};
    auto head = repo.value().head();
    if (!head) throw rpc::HandlerError{{head.error()}};
    return {{"head",
             {{"oid", head.value().oid},
              {"branch", head.value().branch},
              {"detached", head.value().detached},
              {"unborn", head.value().unborn}}}};
  });

  dispatcher.notification("doc/didChange", [&docOverlay](const rpc::Json& params) {
    docOverlay.update(params.value("repoId", ""), params.value("path", ""),
                      params.value("contents", ""), params.value("version", std::int64_t{0}));
  });

  dispatcher.notification("doc/didClose", [&docOverlay](const rpc::Json& params) {
    docOverlay.close(params.value("repoId", ""), params.value("path", ""));
  });

  dispatcher.method(
      "blame/file",
      [&registry, &blameService, &docOverlay](const rpc::Json& params, const CancelToken& token,
                                              const rpc::NotifyFn& notify) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        const std::string streamId = params.value("streamId", "");
        auto repo = registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        services::BlameRequest request;
        request.path = params.value("path", "");
        if (request.path.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' is required"}};
        }
        if (params.contains("rev") && params["rev"].is_string()) {
          request.rev = params["rev"].get<std::string>();
        }
        // Working-tree blame respects unsaved editor contents when pushed.
        if (!request.rev) {
          if (auto doc = docOverlay.get(repoId, request.path)) {
            request.contents = std::move(doc->contents);
          }
        }

        std::uint32_t totalLines = 0;
        auto summary = blameService.blame(
            repo.value(), request, token, [&](const exec::BlameHunk& hunk) {
              totalLines = std::max(totalLines, hunk.resultLine + hunk.lineCount - 1);
              rpc::Json hunkJson = {{"streamId", streamId},
                                    {"sha", hunk.sha},
                                    {"resultLine", hunk.resultLine},
                                    {"originalLine", hunk.originalLine},
                                    {"lineCount", hunk.lineCount},
                                    {"path", hunk.path}};
              if (hunk.previousSha) {
                hunkJson["previous"] = {{"sha", *hunk.previousSha}, {"path", *hunk.previousPath}};
              }
              notify("blame/hunk", hunkJson);
            });
        if (!summary) throw rpc::HandlerError{{summary.error()}};

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

  while (!shutdownRequested) {
    auto payload = reader.read();
    if (!payload) break;  // stdin closed: exit cleanly, never orphan
    dispatcher.dispatch(*payload);
  }

  pool.shutdown();
  spdlog::info("engine exiting");
  return 0;
}

}  // namespace gg
