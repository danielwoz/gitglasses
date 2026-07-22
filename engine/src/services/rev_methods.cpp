#include "services/rev_methods.h"

#include <git2.h>

#include <memory>
#include <string>

namespace gg::services {

namespace {

struct ObjectDeleter {
  void operator()(git_object* object) const { git_object_free(object); }
};
using ObjectPtr = std::unique_ptr<git_object, ObjectDeleter>;

// Unlike core::lastGitError, always reports GitError: an unresolvable rev or
// path is GIT_ENOTFOUND to libgit2, but not a missing repository.
Error revGitError(const std::string& context) {
  const git_error* err = git_error_last();
  const std::string detail = err && err->message ? err->message : "unknown libgit2 error";
  return {ErrorCode::GitError, context + ": " + detail};
}

}  // namespace

void registerRevMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "rev/fileAtRev",
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        const std::string path = params.value("path", "");
        const std::string rev = params.value("rev", "");
        if (path.empty() || rev.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' and 'rev' are required"}};
        }
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const std::string spec = rev + ":" + path;
        git_object* raw = nullptr;
        if (git_revparse_single(&raw, repo.value().raw(), spec.c_str()) != 0) {
          throw rpc::HandlerError{{revGitError("resolve '" + spec + "'")}};
        }
        ObjectPtr object(raw);
        if (git_object_type(raw) != GIT_OBJECT_BLOB) {
          throw rpc::HandlerError{{ErrorCode::GitError, "'" + spec + "' is not a file"}};
        }
        const auto* blob = reinterpret_cast<const git_blob*>(raw);
        const auto size = static_cast<size_t>(git_blob_rawsize(blob));
        std::string contents(static_cast<const char*>(git_blob_rawcontent(blob)), size);
        return {{"contents", std::move(contents)}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
