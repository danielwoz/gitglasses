#include "services/refs/refs_methods.h"

#include <git2.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"

namespace gg::services {

namespace {

// "WIP on main: abc123 subject" / "On main: message" -> "main". Detached-head
// stashes ("(no branch)") report no branch.
std::optional<std::string> stashBranch(const std::string& message) {
  std::string_view rest(message);
  if (rest.rfind("WIP on ", 0) == 0) {
    rest.remove_prefix(7);
  } else if (rest.rfind("On ", 0) == 0) {
    rest.remove_prefix(3);
  } else {
    return std::nullopt;
  }
  const size_t colon = rest.find(':');
  if (colon == std::string_view::npos || colon == 0) return std::nullopt;
  std::string branch(rest.substr(0, colon));
  if (branch == "(no branch)") return std::nullopt;
  return branch;
}

}  // namespace

void registerRefsMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method("refs/list", [&context](const rpc::Json& params, const CancelToken&,
                                            const rpc::NotifyFn&) -> rpc::Json {
    auto repo = context.registry.open(params.value("repoId", ""));
    if (!repo) throw rpc::HandlerError{{repo.error()}};
    git_repository* raw = repo.value().raw();

    // Local branches.
    rpc::Json branches = rpc::Json::array();
    {
      git_branch_iterator* rawIter = nullptr;
      if (git_branch_iterator_new(&rawIter, raw, GIT_BRANCH_LOCAL) != 0) {
        throw rpc::HandlerError{{core::gitError("list local branches")}};
      }
      core::BranchIteratorPtr iter(rawIter);
      git_reference* rawRef = nullptr;
      git_branch_t type;
      while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
        core::ReferencePtr ref(rawRef);
        const char* name = nullptr;
        if (git_branch_name(&name, ref.get()) != 0) continue;
        rpc::Json branch = {{"name", name},
                            {"sha", core::commitShaOf(ref.get())},
                            {"current", git_branch_is_head(ref.get()) == 1}};
        git_reference* rawUpstream = nullptr;
        if (git_branch_upstream(&rawUpstream, ref.get()) == 0) {
          core::ReferencePtr upstream(rawUpstream);
          const char* upstreamName = nullptr;
          if (git_branch_name(&upstreamName, upstream.get()) == 0) {
            branch["upstream"] = upstreamName;
          }
        }
        branches.push_back(std::move(branch));
      }
    }

    // Remote branches, grouped by remote. Configured remotes are listed even
    // when nothing has been fetched yet; matching a branch to its remote uses
    // the longest configured-name prefix so remote names containing '/' group
    // correctly.
    std::vector<std::pair<std::string, rpc::Json>> remoteGroups;
    {
      git_strarray remoteNames{};
      if (git_remote_list(&remoteNames, raw) == 0) {
        for (size_t i = 0; i < remoteNames.count; ++i) {
          remoteGroups.emplace_back(remoteNames.strings[i], rpc::Json::array());
        }
        git_strarray_dispose(&remoteNames);
      }
      git_branch_iterator* rawIter = nullptr;
      if (git_branch_iterator_new(&rawIter, raw, GIT_BRANCH_REMOTE) != 0) {
        throw rpc::HandlerError{{core::gitError("list remote branches")}};
      }
      core::BranchIteratorPtr iter(rawIter);
      git_reference* rawRef = nullptr;
      git_branch_t type;
      while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
        core::ReferencePtr ref(rawRef);
        // Skip symbolic refs like refs/remotes/origin/HEAD.
        if (git_reference_type(ref.get()) == GIT_REFERENCE_SYMBOLIC) continue;
        const char* shorthand = nullptr;
        if (git_branch_name(&shorthand, ref.get()) != 0) continue;
        const std::string full(shorthand);  // "origin/main"
        rpc::Json* group = nullptr;
        size_t prefixLen = 0;
        for (auto& [remoteName, groupBranches] : remoteGroups) {
          const std::string prefix = remoteName + "/";
          if (full.rfind(prefix, 0) == 0 && prefix.size() > prefixLen) {
            group = &groupBranches;
            prefixLen = prefix.size();
          }
        }
        if (!group) {
          // Stale tracking ref for a since-removed remote: first path segment.
          const size_t slash = full.find('/');
          if (slash == std::string::npos) continue;
          remoteGroups.emplace_back(full.substr(0, slash), rpc::Json::array());
          group = &remoteGroups.back().second;
          prefixLen = slash + 1;
        }
        group->push_back({{"name", full.substr(prefixLen)}, {"sha", core::commitShaOf(ref.get())}});
      }
    }
    rpc::Json remotes = rpc::Json::array();
    for (auto& [name, groupBranches] : remoteGroups) {
      remotes.push_back({{"name", name}, {"branches", std::move(groupBranches)}});
    }

    // Tags, peeled to their commit.
    rpc::Json tags = rpc::Json::array();
    {
      git_reference_iterator* rawIter = nullptr;
      if (git_reference_iterator_glob_new(&rawIter, raw, "refs/tags/*") != 0) {
        throw rpc::HandlerError{{core::gitError("list tags")}};
      }
      core::ReferenceIteratorPtr iter(rawIter);
      git_reference* rawRef = nullptr;
      while (git_reference_next(&rawRef, iter.get()) == 0) {
        core::ReferencePtr ref(rawRef);
        const std::string sha = core::commitShaOf(ref.get());
        if (sha.empty()) continue;  // tag of a tree/blob: not a commit ref
        tags.push_back({{"name", git_reference_shorthand(ref.get())}, {"sha", sha}});
      }
    }

    return {{"branches", std::move(branches)},
            {"remotes", std::move(remotes)},
            {"tags", std::move(tags)}};
  });

  dispatcher.method("stash/list", [&context](const rpc::Json& params, const CancelToken&,
                                             const rpc::NotifyFn&) -> rpc::Json {
    auto repo = context.registry.open(params.value("repoId", ""));
    if (!repo) throw rpc::HandlerError{{repo.error()}};

    rpc::Json entries = rpc::Json::array();
    auto callback = [](size_t index, const char* message, const git_oid* stashId,
                       void* payload) -> int {
      auto& out = *static_cast<rpc::Json*>(payload);
      const std::string text = message ? message : "";
      rpc::Json entry = {{"index", index}, {"sha", core::oidToHex(*stashId)}, {"message", text}};
      if (auto branch = stashBranch(text)) entry["branch"] = *branch;
      out.push_back(std::move(entry));
      return 0;
    };
    if (git_stash_foreach(repo.value().raw(), callback, &entries) != 0) {
      throw rpc::HandlerError{{core::gitError("list stashes")}};
    }
    return {{"entries", std::move(entries)}};
  });
}

}  // namespace gg::services
