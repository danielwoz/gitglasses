#include "services/rev_methods.h"

#include <git2.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "core/git2.h"
#include "services/params.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

// Trims a prefix back to the last complete UTF-8 sequence, so truncation
// never emits a half character the client would render as U+FFFD.
std::size_t utf8Boundary(const std::string& text, std::size_t limit) {
  while (limit > 0 && (static_cast<unsigned char>(text[limit]) & 0xc0) == 0x80) --limit;
  return limit;
}

// The id of the blob at `path` in `rev`'s tree, read from the trees alone,
// or empty when the revision or the path does not resolve to a file.
std::optional<git_oid> blobIdAt(git_repository* repo, const std::string& rev,
                                const std::string& path) {
  git_object* rawTree = nullptr;
  const std::string treeSpec = rev + "^{tree}";
  if (git_revparse_single(&rawTree, repo, treeSpec.c_str()) != 0) return std::nullopt;
  core::ObjectPtr tree(rawTree);
  git_tree_entry* rawEntry = nullptr;
  if (git_tree_entry_bypath(&rawEntry, reinterpret_cast<git_tree*>(rawTree), path.c_str()) != 0) {
    return std::nullopt;
  }
  std::unique_ptr<git_tree_entry, decltype(&git_tree_entry_free)> entry(rawEntry,
                                                                        git_tree_entry_free);
  if (git_tree_entry_type(entry.get()) != GIT_OBJECT_BLOB) return std::nullopt;
  return *git_tree_entry_id(entry.get());
}

// Resolves "<rev>:<path>". In a partial clone the tree names a blob the
// object database may not hold yet: with the git CLI available it is
// downloaded (`git cat-file` fetches a missing object from the promisor
// remote), otherwise the request says it is not available offline instead of
// reporting a missing object.
core::ObjectPtr resolveFileAtRev(const core::Repo& repo, const std::string& rev,
                                 const std::string& path, bool mayFetch, const CancelToken& token) {
  const std::string spec = rev + ":" + path;
  git_object* raw = nullptr;
  if (git_revparse_single(&raw, repo.raw(), spec.c_str()) == 0) return core::ObjectPtr(raw);
  const Error resolveError = core::gitError("resolve '" + spec + "'");

  const std::optional<git_oid> blobId = blobIdAt(repo.raw(), rev, path);
  git_odb* rawOdb = nullptr;
  if (!blobId || !status_detail::isPartialClone(repo.raw()) ||
      git_repository_odb(&rawOdb, repo.raw()) != 0) {
    throw rpc::HandlerError{{resolveError}};
  }
  std::unique_ptr<git_odb, decltype(&git_odb_free)> odb(rawOdb, git_odb_free);
  if (git_odb_exists(odb.get(), &*blobId)) throw rpc::HandlerError{{resolveError}};

  const std::string blobHex = core::oidToHex(*blobId);
  if (!mayFetch) {
    throw rpc::HandlerError{
        {ErrorCode::GitError, "'" + spec + "' is not available offline: this partial clone " +
                                  "has not downloaded blob " + blobHex +
                                  ", and fetching it needs the git CLI outside Restricted Mode"}};
  }
  auto fetched = status_detail::fetchThroughGit(repo, {"cat-file", "-t", blobHex}, token);
  if (!fetched) {
    throw rpc::HandlerError{
        {ErrorCode::GitError,
         "'" + spec + "' is not available offline: downloading blob " + blobHex +
             " from the partial clone's remote failed: " + fetched.error().message}};
  }
  if (git_object_lookup(&raw, repo.raw(), &*blobId, GIT_OBJECT_BLOB) != 0) {
    throw rpc::HandlerError{{core::gitError("read '" + spec + "'")}};
  }
  return core::ObjectPtr(raw);
}

}  // namespace

void registerRevMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Contents of one file at one revision. The bytes are run through the
  // repository's checkout filters, so what comes back is what a checkout
  // writes and compares byte-for-byte against an editor buffer even under
  // core.autocrlf. A partial clone's blob that is not present locally is
  // downloaded when the git CLI may run.
  dispatcher.method(
      "rev/fileAtRev",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        const std::string path = requireString(params, "path");
        const std::string rev = requireString(params, "rev");
        const auto maxBytes = static_cast<std::size_t>(
            optionalInteger(params, "maxBytes", 1, kMaxFileBytes, kDefaultFileBytes));
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const std::string spec = rev + ":" + path;
        core::ObjectPtr object =
            resolveFileAtRev(repo.value(), rev, path, context.cliAvailable, token);
        git_object* raw = object.get();
        if (git_object_type(raw) != GIT_OBJECT_BLOB) {
          throw rpc::HandlerError{{ErrorCode::GitError, "'" + spec + "' is not a file"}};
        }
        auto* blob = reinterpret_cast<git_blob*>(raw);
        const auto size = static_cast<std::int64_t>(git_blob_rawsize(blob));

        // Binary content is reported, not shipped: it has no text form, and
        // JSON encoding replaces every invalid sequence with U+FFFD.
        if (git_blob_is_binary(blob) != 0) {
          return {{"contents", ""}, {"size", size}, {"truncated", false}, {"binary", true}};
        }

        git_blob_filter_options options;
        git_blob_filter_options_init(&options, GIT_BLOB_FILTER_OPTIONS_VERSION);
        options.flags = GIT_BLOB_FILTER_CHECK_FOR_BINARY | GIT_BLOB_FILTER_ATTRIBUTES_FROM_HEAD;
        git_buf filtered = GIT_BUF_INIT;
        if (git_blob_filter(&filtered, blob, path.c_str(), &options) != 0) {
          throw rpc::HandlerError{{core::gitError("filter '" + spec + "'")}};
        }
        std::string contents(filtered.ptr, filtered.size);
        git_buf_dispose(&filtered);

        const bool truncated = contents.size() > maxBytes;
        if (truncated) contents.resize(utf8Boundary(contents, maxBytes));
        return {{"contents", std::move(contents)},
                {"size", size},
                {"truncated", truncated},
                {"binary", false}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
