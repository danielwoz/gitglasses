#include "services/notes/notes_methods.h"

#include <git2.h>
#include <spdlog/spdlog.h>

#include <memory>
#include <set>
#include <string>
#include <vector>

#include "core/git2.h"
#include "services/mutate/mutate_common.h"
#include "services/notes/git_ai_note.h"
#include "services/notes/notes_store.h"
#include "services/params.h"

namespace gg::services {

namespace {

using mutate_detail::openRepo;
using mutate_detail::requirePositional;
using mutate_detail::runGitOrThrow;

// The `ref` param: a full ref under refs/notes/, refs/notes/ai when absent.
std::string notesRefParam(const rpc::Json& params) {
  std::string ref = optionalString(params, "ref");
  if (ref.empty()) return std::string(notes::kGitAiNotesRef);
  if (!notes::isNotesRef(ref)) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, "'ref' must be a valid ref name under refs/notes/"}};
  }
  return ref;
}

// The local ref one of `remote`'s fetch refspecs already brings `ref` into,
// when that is `ref` itself or a remote copy of it (`<ref>-remote/...`);
// "" when none does.
std::string fetchedInto(git_remote* remote, const std::string& ref) {
  const std::string copies = ref + "-remote/";
  const std::size_t count = git_remote_refspec_count(remote);
  for (std::size_t i = 0; i < count; ++i) {
    const git_refspec* spec = git_remote_get_refspec(remote, i);
    if (!spec || git_refspec_direction(spec) != GIT_DIRECTION_FETCH) continue;
    if (!git_refspec_src_matches(spec, ref.c_str())) continue;
    core::BufDisposer target;
    if (git_refspec_transform(&target.buf, spec, ref.c_str()) != 0 || target.buf.ptr == nullptr) {
      continue;
    }
    const std::string into = target.buf.ptr;
    if (into == ref || into.rfind(copies, 0) == 0) return into;
  }
  return {};
}

}  // namespace

void registerNotesMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // The notes `ref` (refs/notes/ai by default) attaches to each commit in
  // `shas`. A commit without one is left out of `notes`; one whose note is
  // too long or cannot be read is listed in `omitted`.
  dispatcher.method(
      "notes/read",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::vector<std::string> shas =
            notes::requireCommitShas(params, "shas", kMaxNotesReadShas);
        const std::string ref = notesRefParam(params);
        const std::string repoId = params.value("repoId", "");
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto tip = notes::notesTip(repo.value(), ref);
        if (!tip) throw rpc::HandlerError{{tip.error()}};
        rpc::Json found = rpc::Json::object();
        rpc::Json omitted = rpc::Json::array();
        if (!tip.value().empty()) {
          std::set<std::string> done;
          for (const std::string& sha : shas) {
            token.throwIfCancelled();
            if (!done.insert(sha).second) continue;
            const notes::Note note =
                notes::readNote(repo.value(), context.notesCache, repoId, ref, tip.value(), sha);
            switch (note.state) {
              case notes::NoteState::Absent:
                break;
              case notes::NoteState::Present:
                if (note.text.size() <= kMaxNotesReadBytes) {
                  found[sha] = note.text;
                  break;
                }
                [[fallthrough]];
              case notes::NoteState::TooLarge:
              case notes::NoteState::Unreadable:
                omitted.push_back(sha);
                break;
            }
          }
        }
        return {{"ref", ref},
                {"exists", !tip.value().empty()},
                {"notes", std::move(found)},
                {"omitted", std::move(omitted)}};
      },
      rpc::Mode::Concurrent);

  // Adds `+<ref>:<ref>-remote/<remote>` to remote.<remote>.fetch, so later
  // fetches from the remote bring its notes along. They land in a ref of
  // their own, which commit/provenance also reads, because a forced fetch
  // into `ref` itself would replace the notes written locally for commits
  // not yet pushed. Nothing changes when a fetch refspec of the remote
  // already brings the ref into itself or into such a copy.
  dispatcher.method(
      "notes/addFetchRefspec",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string remoteName = requirePositional(requireString(params, "remote"), "remote");
        const std::string ref = notesRefParam(params);
        core::Repo repo = openRepo(context, params);

        git_remote* raw = nullptr;
        if (git_remote_lookup(&raw, repo.raw(), remoteName.c_str()) != 0) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "no remote named '" + remoteName + "'"}};
        }
        std::unique_ptr<git_remote, decltype(&git_remote_free)> remote(raw, git_remote_free);
        const std::string existing = fetchedInto(remote.get(), ref);
        if (!existing.empty()) return {{"added", false}, {"trackingRef", existing}};

        const std::string tracking = notes::remoteNotesRef(ref, remoteName);
        runGitOrThrow(
            repo,
            {"config", "--add", "remote." + remoteName + ".fetch", "+" + ref + ":" + tracking},
            token, "git config --add");
        spdlog::info("notes: remote {} now fetches {} into {}", remoteName, ref, tracking);
        return {{"added", true}, {"trackingRef", tracking}};
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
