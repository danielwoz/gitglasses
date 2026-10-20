#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace gg::services::notes {

// The notes ref git-ai attaches its authorship logs under.
inline constexpr std::string_view kGitAiNotesRef = "refs/notes/ai";

// Most parties one note may declare; a note naming more is cut short there.
inline constexpr std::size_t kMaxGitAiAuthors = 32;

// One party a git-ai authorship log says wrote lines of its commit: an AI
// session (a `sessions` record or a legacy `prompts` record) or a known human
// (a `humans` record). Only parties with attested lines are listed.
struct GitAiAuthor {
  bool agent = false;
  // agent_id.tool ("cursor", "claude", ...); empty for a human.
  std::string tool;
  // agent_id.model as written; may be empty.
  std::string model;
  // agent_id.id: the conversation in the tool's own terms.
  std::string sessionId;
  // The human behind the lines: human_author for a session, author for a
  // known human.
  std::string human;
  // A legacy prompt record's messages_url, kept only when it is an http(s)
  // URL. Rendered as a link by clients, never fetched.
  std::string messagesUrl;
};

enum class GitAiNoteStatus {
  // An authorship/3.x log: `authors` lists what it declares.
  Read,
  // A schema_version this adapter does not read (another major version, or
  // the pre-3 JSON-only format); nothing is taken from it.
  UnsupportedVersion,
  // Not an authorship log at all.
  Malformed,
};

struct GitAiNote {
  GitAiNoteStatus status = GitAiNoteStatus::Malformed;
  // schema_version as written, when the note carries one.
  std::string schemaVersion;
  // Parties in the order the attestation section first names them, each
  // once. Empty unless status is Read.
  std::vector<GitAiAuthor> authors;
};

// Reads a git-ai authorship log (Git AI Standard v3.0.0): an attestation
// section of file paths and indented `<key> <line ranges>` entries, a line
// holding exactly `---`, then a JSON metadata object. Session keys
// (`s_<id>::t_<id>`) resolve through `sessions`, human keys (`h_<id>`, or
// `h_<id>::t_<id>`) through `humans`, and bare hex keys through the legacy `prompts`. Keys of
// any other shape, keys the metadata does not define and malformed entries
// are skipped, so a newer minor version that adds kinds of keys still reads.
GitAiNote parseGitAiNote(std::string_view text);

}  // namespace gg::services::notes
