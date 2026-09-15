#include "services/rev_methods.h"

#include <git2.h>

#include <cstdint>
#include <string>
#include <utility>

#include "core/git2.h"
#include "services/params.h"

namespace gg::services {

namespace {

// Trims a prefix back to the last complete UTF-8 sequence, so truncation
// never emits a half character the client would render as U+FFFD.
std::size_t utf8Boundary(const std::string& text, std::size_t limit) {
  while (limit > 0 && (static_cast<unsigned char>(text[limit]) & 0xc0) == 0x80) --limit;
  return limit;
}

}  // namespace

void registerRevMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Contents of one file at one revision. The bytes are run through the
  // repository's checkout filters, so what comes back is what a checkout
  // writes and compares byte-for-byte against an editor buffer even under
  // core.autocrlf.
  dispatcher.method(
      "rev/fileAtRev",
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        const std::string path = requireString(params, "path");
        const std::string rev = requireString(params, "rev");
        const auto maxBytes = static_cast<std::size_t>(
            optionalInteger(params, "maxBytes", 1, kMaxFileBytes, kDefaultFileBytes));
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const std::string spec = rev + ":" + path;
        git_object* raw = nullptr;
        if (git_revparse_single(&raw, repo.value().raw(), spec.c_str()) != 0) {
          throw rpc::HandlerError{{core::gitError("resolve '" + spec + "'")}};
        }
        core::ObjectPtr object(raw);
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
