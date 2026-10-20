// Unit tests for declared commit provenance: the git-ai authorship log
// adapter, the agent identity table, trailer parsing and how the sources
// combine. The notes are the Git AI Standard v3.0.0's own examples.

#include <gtest/gtest.h>

#include <string>
#include <utility>
#include <vector>

#include "services/commit/provenance.h"
#include "services/notes/git_ai_note.h"

namespace gg {
namespace {

using services::notes::GitAiNote;
using services::notes::GitAiNoteStatus;
using services::notes::parseGitAiNote;
namespace provenance = services::provenance;
using Trailers = std::vector<std::pair<std::string, std::string>>;

// --- git-ai notes ---------------------------------------------------------------

constexpr const char* kSessionsNote = R"json(src/main.rs
  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20
  s_c9883b05a2487d::t_a1b2c3d4e5f678 25,30-35
  h_31dce776f88375 42-50
src/lib.rs
  s_e7f2a90b31cc48::t_deadbeef012345 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.4.5",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {},
  "humans": {
    "h_31dce776f88375": {
      "author": "Developer <dev@example.com>"
    }
  },
  "sessions": {
    "s_c9883b05a2487d": {
      "agent_id": {
        "tool": "cursor",
        "id": "6ef2299e-a67f-432b-aa80-3d2fb4d28999",
        "model": "claude-sonnet-4-5-20250514"
      },
      "human_author": "dev@example.com"
    },
    "s_e7f2a90b31cc48": {
      "agent_id": {
        "tool": "claude",
        "id": "conv_abc123def456",
        "model": "claude-sonnet-4-5-20250514"
      },
      "human_author": "dev@example.com",
      "custom_attributes": {
        "team": "backend"
      }
    }
  }
}
)json";

constexpr const char* kLegacyNote = R"json(src/main.rs
  abcd1234abcd1234 1-10,15-20
  ef0b5678ef0b5678 25,30-35
src/lib.rs
  abcd1234abcd1234 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.0.23",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {
        "tool": "cursor",
        "id": "6ef2299e-a67f-432b-aa80-3d2fb4d28999",
        "model": "claude-4.5-opus"
      },
      "human_author": "Developer <dev@example.com>",
      "messages_url": "https://transcripts.example.com/6ef2299e",
      "total_additions": 25,
      "total_deletions": 5,
      "accepted_lines": 20,
      "overriden_lines": 0
    },
    "ef0b5678ef0b5678": {
      "agent_id": {
        "tool": "cursor",
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "model": "claude-3-sonnet"
      },
      "human_author": "Developer <dev@example.com>",
      "messages_url": "javascript:alert(1)",
      "total_additions": 6,
      "total_deletions": 0,
      "accepted_lines": 6,
      "overriden_lines": 0
    }
  }
}
)json";

constexpr const char* kMixedNote = R"json(src/main.rs
  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10
  h_31dce776f88375 15-20
src/lib.rs
  abcd1234abcd1234 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.4.5",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": {"tool": "cursor", "id": "old_session_id", "model": "gpt-4"},
      "human_author": "Developer <dev@example.com>",
      "total_additions": 50, "total_deletions": 0, "accepted_lines": 50, "overriden_lines": 0
    }
  },
  "humans": {"h_31dce776f88375": {"author": "Developer <dev@example.com>"}},
  "sessions": {
    "s_c9883b05a2487d": {
      "agent_id": {"tool": "claude", "id": "conv_abc123", "model": "claude-sonnet-4-5-20250514"},
      "human_author": "dev@example.com"
    }
  }
}
)json";

TEST(GitAiNote, ReadsSessionsAndKnownHumansInAttestationOrder) {
  const GitAiNote note = parseGitAiNote(kSessionsNote);
  ASSERT_EQ(note.status, GitAiNoteStatus::Read);
  EXPECT_EQ(note.schemaVersion, "authorship/3.0.0");
  ASSERT_EQ(note.authors.size(), 3u);

  EXPECT_TRUE(note.authors[0].agent);
  EXPECT_EQ(note.authors[0].tool, "cursor");
  EXPECT_EQ(note.authors[0].model, "claude-sonnet-4-5-20250514");
  EXPECT_EQ(note.authors[0].sessionId, "6ef2299e-a67f-432b-aa80-3d2fb4d28999");
  EXPECT_EQ(note.authors[0].human, "dev@example.com");
  EXPECT_EQ(note.authors[0].messagesUrl, "");

  EXPECT_FALSE(note.authors[1].agent);
  EXPECT_EQ(note.authors[1].human, "Developer <dev@example.com>");

  EXPECT_TRUE(note.authors[2].agent);
  EXPECT_EQ(note.authors[2].tool, "claude");
  EXPECT_EQ(note.authors[2].sessionId, "conv_abc123def456");
}

TEST(GitAiNote, ReadsLegacyPromptsAndKeepsOnlyHttpTranscriptLinks) {
  const GitAiNote note = parseGitAiNote(kLegacyNote);
  ASSERT_EQ(note.status, GitAiNoteStatus::Read);
  ASSERT_EQ(note.authors.size(), 2u);
  EXPECT_EQ(note.authors[0].model, "claude-4.5-opus");
  EXPECT_EQ(note.authors[0].human, "Developer <dev@example.com>");
  EXPECT_EQ(note.authors[0].messagesUrl, "https://transcripts.example.com/6ef2299e");
  EXPECT_EQ(note.authors[1].model, "claude-3-sonnet");
  EXPECT_EQ(note.authors[1].messagesUrl, "") << "a non-http link is dropped";
}

TEST(GitAiNote, ReadsAllThreeKeyFormatsInOneNote) {
  const GitAiNote note = parseGitAiNote(kMixedNote);
  ASSERT_EQ(note.status, GitAiNoteStatus::Read);
  ASSERT_EQ(note.authors.size(), 3u);
  EXPECT_EQ(note.authors[0].tool, "claude");
  EXPECT_FALSE(note.authors[1].agent);
  EXPECT_EQ(note.authors[2].tool, "cursor");
  EXPECT_EQ(note.authors[2].model, "gpt-4");
}

TEST(GitAiNote, ReadsLaterMinorVersionsOfTheSameMajor) {
  std::string note = kSessionsNote;
  note.replace(note.find("authorship/3.0.0"), 16, "authorship/3.2.1");
  const GitAiNote parsed = parseGitAiNote(note);
  EXPECT_EQ(parsed.status, GitAiNoteStatus::Read);
  EXPECT_EQ(parsed.authors.size(), 3u);
}

TEST(GitAiNote, NamesButDoesNotReadAnotherMajorVersion) {
  std::string note = kSessionsNote;
  note.replace(note.find("authorship/3.0.0"), 16, "authorship/4.0.0");
  const GitAiNote parsed = parseGitAiNote(note);
  EXPECT_EQ(parsed.status, GitAiNoteStatus::UnsupportedVersion);
  EXPECT_EQ(parsed.schemaVersion, "authorship/4.0.0");
  EXPECT_TRUE(parsed.authors.empty());
}

TEST(GitAiNote, NamesButDoesNotReadThePreThreeJsonFormat) {
  const GitAiNote parsed =
      parseGitAiNote(R"json({"schema_version": "authorship/2.1.0", "attestations": []})json");
  EXPECT_EQ(parsed.status, GitAiNoteStatus::UnsupportedVersion);
  EXPECT_EQ(parsed.schemaVersion, "authorship/2.1.0");
  EXPECT_TRUE(parsed.authors.empty());
}

TEST(GitAiNote, RejectsWhatIsNotAnAuthorshipLog) {
  EXPECT_EQ(parseGitAiNote("Reviewed in the weekly sync.\n").status, GitAiNoteStatus::Malformed);
  EXPECT_EQ(parseGitAiNote("").status, GitAiNoteStatus::Malformed);
  EXPECT_EQ(parseGitAiNote("a.txt\n  abcd1234abcd1234 1-2\n---\nnot json\n").status,
            GitAiNoteStatus::Malformed);
  EXPECT_EQ(parseGitAiNote("a.txt\n  abcd1234abcd1234 1-2\n---\n{\"prompts\": {}}\n").status,
            GitAiNoteStatus::Malformed)
      << "no schema_version";
}

TEST(GitAiNote, SkipsEntriesItCannotResolve) {
  const GitAiNote note = parseGitAiNote(
      "a.txt\r\n"
      "  x_0123456789abcd 1-2\r\n"             // a key format this adapter does not know
      "  s_0000000000000::t_1111111111 3\r\n"  // a session the metadata does not define
      "  abcd1234abcd1234 1-two\r\n"           // malformed line ranges
      "   abcd1234abcd1234 4\r\n"              // three spaces: not an attestation
      "  s_c9883b05a2487d 5\r\n"               // a session key without its trace id
      "  abcd1234abcd1234 6-8\r\n"
      "---\r\n"
      R"json({"schema_version": "authorship/3.0.0", "prompts": {
            "abcd1234abcd1234": {"agent_id": {"tool": "codex", "id": "c1", "model": "gpt-5"}}},
          "sessions": {"s_c9883b05a2487d": {"agent_id": {"tool": "claude"}}}})json");
  ASSERT_EQ(note.status, GitAiNoteStatus::Read);
  ASSERT_EQ(note.authors.size(), 1u);
  EXPECT_EQ(note.authors[0].tool, "codex");
  EXPECT_EQ(note.authors[0].model, "gpt-5");
}

TEST(GitAiNote, ANoteWithoutAttestationsDeclaresNobody) {
  const GitAiNote note = parseGitAiNote(
      "---\n"
      R"json({"schema_version": "authorship/3.0.0", "base_commit_sha": "x", "prompts": {
            "abcd1234abcd1234": {"agent_id": {"tool": "cursor"}}}})json");
  EXPECT_EQ(note.status, GitAiNoteStatus::Read);
  EXPECT_TRUE(note.authors.empty());
}

// --- Identities ------------------------------------------------------------------

TEST(AgentIdentities, RecognizesTheAddressesAgentsCommitUnder) {
  using provenance::agentForIdentity;
  EXPECT_EQ(agentForIdentity("Claude", "noreply@anthropic.com", provenance::kCoAuthor), "Claude");
  EXPECT_EQ(agentForIdentity("Cursor Agent", "CursorAgent@Cursor.com", provenance::kAuthor),
            "Cursor");
  EXPECT_EQ(agentForIdentity("Copilot", "copilot@github.com", provenance::kCoAuthor),
            "GitHub Copilot");
  EXPECT_EQ(agentForIdentity("Copilot", "198982749+Copilot@users.noreply.github.com",
                             provenance::kAuthor),
            "GitHub Copilot");
  EXPECT_EQ(agentForIdentity("Codex", "noreply@openai.com", provenance::kCoAuthor), "Codex");
  EXPECT_EQ(agentForIdentity("Amp", "amp@ampcode.com", provenance::kCoAuthor), "Amp");
  EXPECT_EQ(agentForIdentity("aider (gpt-4o)", "aider@aider.chat", provenance::kCoAuthor), "Aider");
  EXPECT_EQ(agentForIdentity("devin-ai-integration[bot]",
                             "158243242+devin-ai-integration[bot]@users.noreply.github.com",
                             provenance::kAuthor),
            "Devin");
  EXPECT_EQ(agentForIdentity("google-labs-jules[bot]",
                             "161369871+google-labs-jules[bot]@users.noreply.github.com",
                             provenance::kCommitter),
            "Jules");
  // A GitHub App keeps its login on GitHub Enterprise, under another id.
  EXPECT_EQ(agentForIdentity("claude[bot]", "41898282+claude[bot]@users.noreply.ghe.example.com",
                             provenance::kAuthor),
            "Claude");
}

TEST(AgentIdentities, LeavesPeopleAlone) {
  using provenance::agentForIdentity;
  EXPECT_EQ(agentForIdentity("Jane", "jane@example.com", provenance::kCoAuthor), "");
  EXPECT_EQ(agentForIdentity("Claude Monet", "claude@example.com", provenance::kAuthor), "");
  // A personal account whose login matches an agent's is told apart by its
  // id.
  EXPECT_EQ(
      agentForIdentity("Copilot", "12345+Copilot@users.noreply.github.com", provenance::kAuthor),
      "");
  EXPECT_EQ(agentForIdentity("x", "noreply@anthropic.com.evil.example", provenance::kAuthor), "");
  EXPECT_EQ(agentForIdentity("x", "1+claude[bot]@example.com", provenance::kAuthor), "");
}

TEST(AgentIdentities, ReadsAiderNameSuffixOnTheAuthorOnly) {
  using provenance::agentForIdentity;
  EXPECT_EQ(agentForIdentity("Jane Doe (aider)", "jane@example.com", provenance::kAuthor), "Aider");
  // Aider renames the committer of commits a person wrote as well.
  EXPECT_EQ(agentForIdentity("Jane Doe (aider)", "jane@example.com", provenance::kCommitter), "");
}

TEST(AgentIdentities, NamesGitAiTools) {
  EXPECT_EQ(provenance::agentForTool("claude"), "Claude");
  EXPECT_EQ(provenance::agentForTool("Copilot"), "GitHub Copilot");
  EXPECT_EQ(provenance::agentForTool("droid"), "Factory Droid");
  EXPECT_EQ(provenance::agentForTool("newtool"), "newtool");
}

// --- Trailers --------------------------------------------------------------------

TEST(ProvenanceTrailers, CoAuthorsCountOnlyWhenTheyAreKnownAgents) {
  const auto declarations = provenance::trailerDeclarations(Trailers{
      {"Signed-off-by", "Jane <jane@example.com>"},
      {"Co-authored-by", "Jane <jane@example.com>"},
      {"Co-Authored-By", "Claude Opus 4.7 <noreply@anthropic.com>"},
      {"co-authored-by", "aider (gpt-4o) <aider@aider.chat>"},
  });
  ASSERT_EQ(declarations.size(), 2u);
  EXPECT_EQ(declarations[0].source, provenance::Source::Trailer);
  EXPECT_EQ(declarations[0].kind, provenance::Kind::Agent);
  EXPECT_EQ(declarations[0].name, "Claude");
  EXPECT_EQ(declarations[0].model, "Opus 4.7");
  EXPECT_EQ(declarations[0].via, "Co-Authored-By");
  EXPECT_EQ(declarations[0].value, "Claude Opus 4.7 <noreply@anthropic.com>");
  EXPECT_EQ(declarations[1].name, "Aider");
  EXPECT_EQ(declarations[1].model, "gpt-4o");
}

TEST(ProvenanceTrailers, ReadsTheKernelAssistedByForm) {
  const auto declarations = provenance::trailerDeclarations(Trailers{
      {"Assisted-by", "Claude:claude-3-opus coccinelle sparse"},
      {"Assisted-by", "Codex:GPT-5.5 [checkpatch]"},
      {"Assisted-by", "Jane Doe <jane@example.com>"},
  });
  ASSERT_EQ(declarations.size(), 2u);
  EXPECT_EQ(declarations[0].name, "Claude");
  EXPECT_EQ(declarations[0].model, "claude-3-opus");
  EXPECT_EQ(declarations[0].via, "Assisted-by");
  EXPECT_EQ(declarations[1].name, "Codex");
  EXPECT_EQ(declarations[1].model, "GPT-5.5");
}

TEST(ProvenanceTrailers, ReadsGeneratedByToolNames) {
  const auto declarations = provenance::trailerDeclarations(Trailers{
      {"Generated-by", "GitHub Copilot Chat"},
      {"Generated-by", "ChatGPT 4o"},
  });
  ASSERT_EQ(declarations.size(), 2u);
  EXPECT_EQ(declarations[0].name, "GitHub Copilot");
  EXPECT_EQ(declarations[1].name, "ChatGPT 4o");
  EXPECT_EQ(declarations[1].value, "ChatGPT 4o");
}

TEST(ProvenanceTrailers, SessionLinksJoinTheirAgentsDeclaration) {
  const auto declarations =
      provenance::combine({},
                          provenance::trailerDeclarations(Trailers{
                              {"Amp-Thread-ID", "https://ampcode.com/threads/T-1"},
                              {"Co-authored-by", "Amp <amp@ampcode.com>"},
                              // A squash merge repeats them.
                              {"Amp-Thread-ID", "https://ampcode.com/threads/T-1"},
                              {"Co-authored-by", "Amp <amp@ampcode.com>"},
                              {"Amp-Thread-ID", "https://ampcode.com/threads/T-2"},
                          }),
                          {});
  ASSERT_EQ(declarations.size(), 2u);
  EXPECT_EQ(declarations[0].name, "Amp");
  EXPECT_EQ(declarations[0].via, "Co-authored-by");
  EXPECT_EQ(declarations[0].url, "https://ampcode.com/threads/T-1");
  EXPECT_EQ(declarations[1].via, "Amp-Thread-ID");
  EXPECT_EQ(declarations[1].url, "https://ampcode.com/threads/T-2");
}

TEST(ProvenanceTrailers, ASessionLinkAloneDeclaresItsAgentButOnlyLinksHttp) {
  const auto declarations = provenance::combine(
      {}, provenance::trailerDeclarations(Trailers{{"Agent-Logs-Url", "file:///etc/passwd"}}), {});
  ASSERT_EQ(declarations.size(), 1u);
  EXPECT_EQ(declarations[0].name, "GitHub Copilot");
  EXPECT_EQ(declarations[0].url, "");
  EXPECT_EQ(declarations[0].value, "file:///etc/passwd");
}

// --- Combining ---------------------------------------------------------------------

TEST(ProvenanceCombine, OrdersNotesThenTrailersThenIdentities) {
  const auto note = parseGitAiNote(kSessionsNote);
  const auto declarations = provenance::combine(
      provenance::noteDeclarations(note, "refs/notes/ai"),
      provenance::trailerDeclarations(
          Trailers{{"Co-authored-by", "Cursor <cursoragent@cursor.com>"}}),
      provenance::identityDeclarations("Copilot", "198982749+Copilot@users.noreply.github.com",
                                       provenance::kAuthor));
  ASSERT_EQ(declarations.size(), 5u);
  EXPECT_EQ(declarations[0].source, provenance::Source::Notes);
  EXPECT_EQ(declarations[0].name, "Cursor");
  EXPECT_EQ(declarations[0].model, "claude-sonnet-4-5-20250514");
  EXPECT_EQ(declarations[0].via, "refs/notes/ai");
  EXPECT_EQ(declarations[0].value, "6ef2299e-a67f-432b-aa80-3d2fb4d28999");
  EXPECT_EQ(declarations[1].kind, provenance::Kind::Human);
  EXPECT_EQ(declarations[1].name, "Developer <dev@example.com>");
  EXPECT_EQ(declarations[2].name, "Claude");
  EXPECT_EQ(declarations[3].source, provenance::Source::Trailer);
  EXPECT_EQ(declarations[4].source, provenance::Source::Identity);
  EXPECT_EQ(declarations[4].via, "author");
  EXPECT_EQ(declarations[4].value, "Copilot <198982749+Copilot@users.noreply.github.com>");
  EXPECT_EQ(provenance::declaredKind(declarations), "agent");
}

TEST(ProvenanceCombine, DeclaredKindIsHumanOnlyForKnownHumansAndUnknownForNothing) {
  const auto human = parseGitAiNote(
      "a.txt\n  h_31dce776f88375 1-3\n---\n"
      R"json({"schema_version": "authorship/3.0.0", "prompts": {},
          "humans": {"h_31dce776f88375": {"author": "Dev <dev@example.com>"}}})json");
  EXPECT_EQ(provenance::declaredKind(
                provenance::combine(provenance::noteDeclarations(human, "refs/notes/ai"), {}, {})),
            "human");
  EXPECT_EQ(provenance::declaredKind({}), "unknown");
  // A note this adapter does not read declares nothing.
  const auto future = parseGitAiNote(
      "a.txt\n  h_31dce776f88375 1-3\n---\n"
      R"json({"schema_version": "authorship/9.0.0", "prompts": {},
          "humans": {"h_31dce776f88375": {"author": "Dev <dev@example.com>"}}})json");
  EXPECT_TRUE(provenance::noteDeclarations(future, "refs/notes/ai").empty());
}

TEST(ProvenanceCombine, CapsTheDeclarationsOfOneCommit) {
  Trailers trailers;
  for (int i = 0; i < 40; ++i) {
    trailers.emplace_back("Assisted-by", "Tool" + std::to_string(i) + ":model");
  }
  const auto declarations = provenance::combine({}, provenance::trailerDeclarations(trailers), {});
  EXPECT_EQ(declarations.size(), provenance::kMaxDeclarations);
}

TEST(ProvenanceCombine, SerializesOptionalMembersOnlyWhenSet) {
  provenance::Declaration declaration;
  declaration.name = "Claude";
  declaration.via = "Co-authored-by";
  declaration.value = "Claude <noreply@anthropic.com>";
  EXPECT_EQ(provenance::declarationJson(declaration),
            nlohmann::json({{"source", "trailer"},
                            {"kind", "agent"},
                            {"name", "Claude"},
                            {"via", "Co-authored-by"},
                            {"value", "Claude <noreply@anthropic.com>"}}));
  declaration.model = "Opus 4.7";
  declaration.url = "https://example.com/s";
  const auto json = provenance::declarationJson(declaration);
  EXPECT_EQ(json["model"], "Opus 4.7");
  EXPECT_EQ(json["url"], "https://example.com/s");
}

}  // namespace
}  // namespace gg
