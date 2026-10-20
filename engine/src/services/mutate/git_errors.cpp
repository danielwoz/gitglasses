#include "services/mutate/git_errors.h"

#include <array>
#include <regex>
#include <string_view>

namespace gg::services {

namespace {

bool containsAny(const std::string& text, std::initializer_list<std::string_view> needles) {
  for (std::string_view needle : needles) {
    if (text.find(needle) != std::string::npos) return true;
  }
  return false;
}

// Host of the first URL or ssh destination the output names.
std::string hostIn(const std::string& output) {
  static const std::regex url(R"(([a-z][a-z0-9+.-]*)://(?:[^@/\s'"]+@)?(\[[^\]]+\]|[^/:\s'"]+))");
  std::smatch match;
  if (std::regex_search(output, match, url)) return match[2].str();
  static const std::regex sshHost(R"(connect to host ([^\s]+) port)");
  if (std::regex_search(output, match, sshHost)) return match[1].str();
  return {};
}

const char* classify(const std::string& output) {
  if (output.rfind("git timed out after", 0) == 0) return "timeout";
  if (containsAny(output,
                  {"gpg failed to sign", "failed to sign the data",
                   "incorrect passphrase supplied to decrypt private key",
                   "signing failed:", "Couldn't load public key", "Couldn't sign message"})) {
    return "signing";
  }
  if (containsAny(output, {"Need to specify how to reconcile divergent branches",
                           "Not possible to fast-forward"})) {
    return "divergent";
  }
  if (containsAny(output,
                  {"Host key verification failed", "REMOTE HOST IDENTIFICATION HAS CHANGED"})) {
    return "hostKey";
  }
  if (output.find("Permission denied (publickey") != std::string::npos) return "publickey";
  if (containsAny(output, {"could not read Username", "could not read Password",
                           "Authentication failed", "Invalid username or password",
                           "HTTP Basic: Access denied", "The requested URL returned error: 401",
                           "The requested URL returned error: 403"})) {
    return "auth";
  }
  if (containsAny(output, {"[rejected]", "[remote rejected]", "Updates were rejected"})) {
    return "rejected";
  }
  if (containsAny(output, {"There is no tracking information for the current branch",
                           "has no upstream branch"})) {
    return "noUpstream";
  }
  if (containsAny(output, {"is now empty, possibly due to conflict resolution",
                           "The previous cherry-pick is now empty"})) {
    return "emptyCommit";
  }
  if (containsAny(output, {"Could not resolve host", "Could not resolve hostname",
                           "Connection refused", "Connection timed out", "Failed to connect to",
                           "Could not read from remote repository", "unable to access",
                           "Network is unreachable"})) {
    return "network";
  }
  return nullptr;
}

}  // namespace

rpc::Json describeGitFailure(const std::string& output) {
  const bool partialClone = output.find("from promisor remote") != std::string::npos;
  const char* kind = classify(output);
  // A partial clone that could not fetch a missing object failed to reach or
  // to authenticate with its promisor remote, whatever git said first.
  if (!kind && partialClone) kind = "network";
  if (!kind) return nullptr;
  rpc::Json data = {{"kind", kind}};
  if (const std::string host = hostIn(output); !host.empty()) data["host"] = host;
  if (partialClone) data["partialClone"] = true;
  return data;
}

rpc::Json gitErrorData(const Error& error) {
  if (error.code != ErrorCode::GitError) return nullptr;
  return describeGitFailure(error.message);
}

}  // namespace gg::services
