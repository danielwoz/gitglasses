#include "services/commit/commit_methods.h"

#include <git2.h>

#include <algorithm>
#include <cstddef>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "core/git2_json.h"
#include "exec/git_process.h"
#include "services/params.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

struct TrailerArray {
  git_message_trailer_array array = {};
  ~TrailerArray() { git_message_trailer_array_free(&array); }
};

// The trailers in the message's closing paragraph, in order.
Result<rpc::Json> trailersJson(const char* message) {
  TrailerArray trailers;
  if (git_message_trailers(&trailers.array, message ? message : "") != 0) {
    return core::gitError("parse trailers");
  }
  rpc::Json out = rpc::Json::array();
  for (std::size_t i = 0; i < trailers.array.count; ++i) {
    const git_message_trailer& trailer = trailers.array.trailers[i];
    out.push_back(
        {{"key", trailer.key ? trailer.key : ""}, {"value", trailer.value ? trailer.value : ""}});
  }
  return out;
}

// HEAD, the local branches, the remote branches and the tags that point at
// `sha` (annotated tags peeled), in that order and alphabetically within
// each kind, as graph/rows decorates its rows.
Result<rpc::Json> refsJson(const core::Repo& repo, const std::string& sha) {
  // (kind rank, name, kind)
  std::vector<std::tuple<int, std::string, const char*>> refs;

  auto head = repo.head();
  if (!head) return head.error();
  if (!head.value().unborn && head.value().oid == sha) refs.emplace_back(0, "HEAD", "head");

  for (const auto& [type, rank, kind] :
       {std::tuple{GIT_BRANCH_LOCAL, 1, "branch"}, std::tuple{GIT_BRANCH_REMOTE, 2, "remote"}}) {
    git_branch_iterator* rawIter = nullptr;
    if (git_branch_iterator_new(&rawIter, repo.raw(), type) != 0) {
      return core::gitError(std::string("list ") + kind + " refs");
    }
    core::BranchIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    git_branch_t found;
    while (git_branch_next(&rawRef, &found, iter.get()) == 0) {
      core::ReferencePtr ref(rawRef);
      // Symbolic remote refs like refs/remotes/origin/HEAD name a branch
      // rather than being one.
      if (type == GIT_BRANCH_REMOTE && git_reference_type(ref.get()) == GIT_REFERENCE_SYMBOLIC) {
        continue;
      }
      if (core::commitShaOf(ref.get()) != sha) continue;
      const char* name = nullptr;
      if (git_branch_name(&name, ref.get()) != 0 || !name) continue;
      refs.emplace_back(rank, name, kind);
    }
  }

  git_reference_iterator* rawIter = nullptr;
  if (git_reference_iterator_glob_new(&rawIter, repo.raw(), "refs/tags/*") != 0) {
    return core::gitError("list tags");
  }
  core::ReferenceIteratorPtr iter(rawIter);
  git_reference* rawRef = nullptr;
  while (git_reference_next(&rawRef, iter.get()) == 0) {
    core::ReferencePtr ref(rawRef);
    if (core::commitShaOf(ref.get()) != sha) continue;
    refs.emplace_back(3, git_reference_shorthand(ref.get()), "tag");
  }

  std::sort(refs.begin(), refs.end(), [](const auto& a, const auto& b) {
    return std::tie(std::get<0>(a), std::get<1>(a)) < std::tie(std::get<0>(b), std::get<1>(b));
  });
  rpc::Json out = rpc::Json::array();
  for (const auto& [rank, name, kind] : refs) out.push_back({{"name", name}, {"kind", kind}});
  return out;
}

}  // namespace

void registerCommitMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // One commit in full: identity, message split into subject, body and
  // trailers, the refs pointing at it, and the files it changes against its
  // first parent (the empty tree for a root commit) with rename detection and
  // line stats, as diff/commit reports them. At most kMaxCommitDetailFiles
  // files are listed; `stats.files` still counts them all.
  dispatcher.method(
      "commit/details",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string rev = requireString(params, "sha");
        if (exec::looksLikeGitOption(rev)) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'sha' may not begin with '-'"}};
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto commit = status_detail::resolveCommit(repo.value(), rev);
        if (!commit) throw rpc::HandlerError{{commit.error()}};
        git_commit* raw = commit.value().get();
        const std::string sha = core::oidToHex(*git_commit_id(raw));

        rpc::Json parents = rpc::Json::array();
        const unsigned int parentCount = git_commit_parentcount(raw);
        for (unsigned int i = 0; i < parentCount; ++i) {
          parents.push_back(core::oidToHex(*git_commit_parent_id(raw, i)));
        }

        auto trailers = trailersJson(git_commit_message(raw));
        if (!trailers) throw rpc::HandlerError{{trailers.error()}};
        auto refs = refsJson(repo.value(), sha);
        if (!refs) throw rpc::HandlerError{{refs.error()}};

        auto diff = status_detail::commitDiff(repo.value(), raw);
        if (!diff) throw rpc::HandlerError{{diff.error()}};
        std::size_t total = 0;
        auto changes =
            status_detail::treeFileChanges(diff.value().get(), token, kMaxCommitDetailFiles, total);
        if (!changes) throw rpc::HandlerError{{changes.error()}};

        rpc::Json files = rpc::Json::array();
        std::size_t additions = 0;
        std::size_t deletions = 0;
        for (const auto& change : changes.value()) {
          rpc::Json file = {{"path", change.path},
                            {"status", std::string(1, change.status)},
                            {"additions", change.additions},
                            {"deletions", change.deletions},
                            {"binary", change.binary}};
          if (!change.origPath.empty()) file["origPath"] = change.origPath;
          files.push_back(std::move(file));
          additions += change.additions;
          deletions += change.deletions;
        }

        const char* subject = git_commit_summary(raw);
        const char* body = git_commit_body(raw);
        return {{"sha", sha},
                {"parents", std::move(parents)},
                {"author", core::signatureJson(git_commit_author(raw))},
                {"committer", core::signatureJson(git_commit_committer(raw))},
                {"subject", subject ? subject : ""},
                {"body", body ? body : ""},
                {"trailers", std::move(trailers.value())},
                {"refs", std::move(refs.value())},
                {"files", std::move(files)},
                {"stats", {{"files", total}, {"additions", additions}, {"deletions", deletions}}},
                {"truncated", total > changes.value().size()}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
