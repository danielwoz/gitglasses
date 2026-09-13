#include "core/git2.h"
#include "core/git2_json.h"

#include <cstdint>

namespace gg::core {

namespace {

std::string lastGitErrorDetail() {
  const git_error* err = git_error_last();
  return err && err->message ? err->message : "unknown libgit2 error";
}

}  // namespace

LibGit2::LibGit2() { git_libgit2_init(); }

LibGit2::~LibGit2() { git_libgit2_shutdown(); }

Error lastGitError(int code, const std::string& context) {
  return {code == GIT_ENOTFOUND ? ErrorCode::RepoNotFound : ErrorCode::GitError,
          context + ": " + lastGitErrorDetail()};
}

Error gitError(const std::string& context) {
  return {ErrorCode::GitError, context + ": " + lastGitErrorDetail()};
}

std::string oidToHex(const git_oid& oid) {
  char hex[GIT_OID_HEXSZ + 1] = {};
  git_oid_fmt(hex, &oid);
  return hex;
}

std::string commitShaOf(git_reference* ref) {
  git_object* obj = nullptr;
  if (git_reference_peel(&obj, ref, GIT_OBJECT_COMMIT) != 0) return {};
  ObjectPtr guard(obj);
  return oidToHex(*git_object_id(obj));
}

nlohmann::json signatureJson(const git_signature* sig) {
  return {{"name", sig && sig->name ? sig->name : ""},
          {"email", sig && sig->email ? sig->email : ""},
          {"time", sig ? static_cast<std::int64_t>(sig->when.time) : 0}};
}

}  // namespace gg::core
