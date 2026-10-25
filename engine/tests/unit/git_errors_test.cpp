// What a git failure was about, read from git's own messages (LC_ALL=C).

#include "services/mutate/git_errors.h"

#include <gtest/gtest.h>

namespace gg::services {
namespace {

std::string kindOf(const std::string& output) {
  const rpc::Json data = describeGitFailure(output);
  return data.is_object() ? data.value("kind", "") : "";
}

TEST(GitErrors, RecognisesCredentialAndSshFailures) {
  EXPECT_EQ(kindOf("fatal: could not read Username for 'https://github.com': terminal prompts "
                   "disabled\n"),
            "auth");
  EXPECT_EQ(kindOf("remote: Invalid username or password.\nfatal: Authentication failed for "
                   "'https://github.com/o/r.git/'\n"),
            "auth");
  EXPECT_EQ(kindOf("Host key verification failed.\nfatal: Could not read from remote "
                   "repository.\n"),
            "hostKey");
  EXPECT_EQ(kindOf("git@github.com: Permission denied (publickey).\nfatal: Could not read from "
                   "remote repository.\n"),
            "publickey");
  EXPECT_EQ(kindOf("ssh: Could not resolve hostname nowhere: Name or service not known\n"),
            "network");
}

TEST(GitErrors, RecognisesSyncFailures) {
  EXPECT_EQ(kindOf(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some "
                   "refs to 'origin'\nhint: Updates were rejected because the remote contains "
                   "work\n"),
            "rejected");
  EXPECT_EQ(kindOf("hint: You have divergent branches and need to specify how to reconcile "
                   "them.\nfatal: Need to specify how to reconcile divergent branches.\n"),
            "divergent");
  EXPECT_EQ(kindOf("fatal: Not possible to fast-forward, aborting.\n"), "divergent");
  EXPECT_EQ(kindOf("There is no tracking information for the current branch.\n"), "noUpstream");
  EXPECT_EQ(kindOf("git timed out after 300000ms"), "timeout");
}

TEST(GitErrors, RecognisesSigningAndEmptyCommits) {
  EXPECT_EQ(kindOf("error: gpg failed to sign the data\nfatal: failed to write commit object\n"),
            "signing");
  EXPECT_EQ(kindOf("error: Load key \"/home/a/.ssh/id\": incorrect passphrase supplied to "
                   "decrypt private key?\nfatal: failed to write commit object\n"),
            "signing");
  EXPECT_EQ(kindOf("The previous cherry-pick is now empty, possibly due to conflict "
                   "resolution.\n"),
            "emptyCommit");
}

TEST(GitErrors, NamesTheHostAndPartialClones) {
  const rpc::Json data = describeGitFailure(
      "fatal: could not read Username for 'https://git.example.com:8443': terminal prompts "
      "disabled\nfatal: could not fetch 1234abcd from promisor remote\n");
  EXPECT_EQ(data["kind"], "auth");
  EXPECT_EQ(data["host"], "git.example.com");
  EXPECT_TRUE(data["partialClone"].get<bool>());
  EXPECT_EQ(describeGitFailure("fatal: could not fetch 1234abcd from promisor remote\n")["kind"],
            "network");
}

TEST(GitErrors, LeavesUnknownFailuresAndOtherErrorsAlone) {
  EXPECT_TRUE(describeGitFailure("fatal: something nobody anticipated\n").is_null());
  EXPECT_TRUE(gitErrorData({ErrorCode::InvalidParams, "Authentication failed"}).is_null());
  EXPECT_EQ(gitErrorData({ErrorCode::GitError, "Authentication failed for 'x'"})["kind"], "auth");
}

}  // namespace
}  // namespace gg::services
