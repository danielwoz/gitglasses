#include "services/status/status_methods.h"

#include <git2.h>

#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

// A FileChange entry. additions/deletions are always 0 here: computing per
// file line stats needs a content diff per entry, which is too expensive for
// a status poll — the UI fetches numbers through the diff/* methods.
rpc::Json fileChange(const char* path, char status, const char* origPath) {
  rpc::Json change = {{"path", path ? path : ""},
                      {"status", std::string(1, status)},
                      {"additions", 0},
                      {"deletions", 0}};
  if (origPath && status == 'R') change["origPath"] = origPath;
  return change;
}

}  // namespace

void registerStatusMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "status/summary",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        git_repository* raw = repo.value().raw();

        auto head = repo.value().head();
        if (!head) throw rpc::HandlerError{{head.error()}};
        // Detached and unborn HEADs report an empty branch name.
        std::string branch = head.value().branch;
        std::string upstreamName;
        size_t ahead = 0, behind = 0;
        if (!head.value().unborn && !head.value().detached) {
          git_reference* rawHead = nullptr;
          if (git_repository_head(&rawHead, raw) == 0) {
            core::ReferencePtr headRef(rawHead);
            git_reference* rawUpstream = nullptr;
            if (git_branch_upstream(&rawUpstream, headRef.get()) == 0) {
              core::ReferencePtr upstream(rawUpstream);
              const char* shorthand = git_reference_shorthand(upstream.get());
              const git_oid* localOid = git_reference_target(headRef.get());
              const git_oid* upstreamOid = git_reference_target(upstream.get());
              if (shorthand && localOid && upstreamOid &&
                  git_graph_ahead_behind(&ahead, &behind, raw, localOid, upstreamOid) == 0) {
                upstreamName = shorthand;
              }
            }
          }
        }

        git_status_options opts;
        git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
        opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
        opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS |
                     GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX;
        git_status_list* rawList = nullptr;
        if (git_status_list_new(&rawList, raw, &opts) != 0) {
          throw rpc::HandlerError{{core::gitError("read status")}};
        }
        core::StatusListPtr list(rawList);

        auto index = status_detail::readIndex(raw);
        if (!index) throw rpc::HandlerError{{index.error()}};

        rpc::Json staged = rpc::Json::array();
        rpc::Json untracked = rpc::Json::array();
        rpc::Json conflicted = rpc::Json::array();
        // Unstaged entries are held back until filtered files have been
        // rechecked, so the list keeps status order.
        struct Unstaged {
          const char* path;
          char status;
          const char* origPath;
          int recheck;  // index into `rechecks`, or -1
        };
        std::vector<Unstaged> unstagedEntries;
        std::vector<status_detail::CleanRecheck> rechecks;
        const size_t count = git_status_list_entrycount(list.get());
        for (size_t i = 0; i < count; ++i) {
          token.throwIfCancelled();
          const git_status_entry* entry = git_status_byindex(list.get(), i);
          if (!entry) continue;
          const git_diff_delta* indexDelta = entry->head_to_index;
          const git_diff_delta* wtDelta = entry->index_to_workdir;

          if (entry->status & GIT_STATUS_CONFLICTED) {
            const git_diff_delta* delta = wtDelta ? wtDelta : indexDelta;
            if (delta) conflicted.push_back(delta->new_file.path ? delta->new_file.path : "");
            continue;
          }
          if (entry->status & GIT_STATUS_WT_NEW) {
            if (wtDelta) untracked.push_back(wtDelta->new_file.path ? wtDelta->new_file.path : "");
            continue;
          }
          if (indexDelta) {
            const char* path = indexDelta->new_file.path;
            const char* origPath = indexDelta->old_file.path;
            if (entry->status & GIT_STATUS_INDEX_RENAMED) {
              staged.push_back(fileChange(path, 'R', origPath));
            } else if (entry->status & GIT_STATUS_INDEX_NEW) {
              staged.push_back(fileChange(path, 'A', nullptr));
            } else if (entry->status & GIT_STATUS_INDEX_DELETED) {
              staged.push_back(fileChange(path, 'D', nullptr));
            } else if (entry->status & GIT_STATUS_INDEX_TYPECHANGE) {
              staged.push_back(fileChange(path, 'T', nullptr));
            } else if (entry->status & GIT_STATUS_INDEX_MODIFIED) {
              staged.push_back(fileChange(path, 'M', nullptr));
            }
          }
          if (wtDelta && !status_detail::workdirSideHidden(index.value().get(), *entry)) {
            const char* path = wtDelta->new_file.path;
            const char* origPath = wtDelta->old_file.path;
            if (entry->status & GIT_STATUS_WT_RENAMED) {
              unstagedEntries.push_back({path, 'R', origPath, -1});
            } else if (entry->status & GIT_STATUS_WT_DELETED) {
              unstagedEntries.push_back({path, 'D', nullptr, -1});
            } else if (entry->status & GIT_STATUS_WT_TYPECHANGE) {
              unstagedEntries.push_back({path, 'T', nullptr, -1});
            } else if (entry->status & GIT_STATUS_WT_MODIFIED) {
              int recheck = -1;
              if (context.cliAvailable && status_detail::needsCleanRecheck(raw, *entry)) {
                recheck = static_cast<int>(rechecks.size());
                rechecks.push_back({path, wtDelta->old_file.id});
              }
              unstagedEntries.push_back({path, 'M', nullptr, recheck});
            }
          }
        }

        // libgit2 hashed the raw bytes of filtered files; git compares their
        // cleaned bytes, which often still match the index after a touch, a
        // checkout or a racy timestamp.
        std::vector<bool> changed;
        if (!rechecks.empty()) {
          changed = status_detail::confirmCleanChanges(repo.value(), rechecks, token);
        }
        rpc::Json unstaged = rpc::Json::array();
        for (const auto& item : unstagedEntries) {
          if (item.recheck >= 0 && !changed[static_cast<size_t>(item.recheck)]) continue;
          unstaged.push_back(fileChange(item.path, item.status, item.origPath));
        }

        rpc::Json result = {{"branch", std::move(branch)},
                            {"ahead", ahead},
                            {"behind", behind},
                            {"staged", std::move(staged)},
                            {"unstaged", std::move(unstaged)},
                            {"untracked", std::move(untracked)},
                            {"conflicted", std::move(conflicted)}};
        if (!upstreamName.empty()) result["upstream"] = std::move(upstreamName);
        return result;
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
