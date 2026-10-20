#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "services/notes/git_ai_note.h"

namespace gg::services::provenance {

// Declared provenance of commits: what a commit's own metadata, or a git-ai
// note attached to it, says about who wrote it. Nothing is inferred from the
// code itself; a commit that declares nothing is "unknown", never "human".

// Where a declaration was read, in priority order.
enum class Source { Notes, Trailer, Identity };

enum class Kind { Agent, Human };

struct Declaration {
  Source source = Source::Trailer;
  Kind kind = Kind::Agent;
  // The agent's display name ("Claude", "GitHub Copilot"), or the human's
  // identity as the source names it.
  std::string name;
  // The model, when the declaration names one.
  std::string model;
  // What carried it: the trailer key as written, "author" or "committer", or
  // the notes ref.
  std::string via;
  // The declaration as written: the trailer value, the "Name <email>"
  // identity, or the session the note names.
  std::string value;
  // A link to the agent session, http(s) only. Clients render it as a link
  // and never fetch it.
  std::string url;
};

// Most declarations reported per commit.
inline constexpr std::size_t kMaxDeclarations = 16;

// Roles an identity can hold in a commit.
enum Role : unsigned { kAuthor = 1u, kCommitter = 2u, kCoAuthor = 4u };

// The display name of the agent `name <email>` belongs to in `role`, from the
// known agent identities, or "" for anyone else.
std::string agentForIdentity(std::string_view name, std::string_view email, Role role);

// The display name of the agent a git-ai `agent_id.tool` names, or `tool`
// itself when it is not a known one.
std::string agentForTool(std::string_view tool);

// Agent declarations among a commit's trailers, in message order: a
// Co-authored-by naming a known agent identity, an Assisted-by or
// Generated-by naming an AI tool (the Linux kernel's `AGENT:MODEL [TOOL...]`
// form, or a known identity), and the session links agents add
// (Amp-Thread-ID, Agent-Logs-Url). A co-author who is not a known agent
// declares nothing.
std::vector<Declaration> trailerDeclarations(
    const std::vector<std::pair<std::string, std::string>>& trailers);

// The author or committer as a declaration, when it is a known agent
// identity.
std::vector<Declaration> identityDeclarations(std::string_view name, std::string_view email,
                                              Role role);

// What a git-ai note read from `ref` declares.
std::vector<Declaration> noteDeclarations(const notes::GitAiNote& note, std::string_view ref);

// Everything a commit declares, highest priority source first: the note's
// declarations, then the trailers', then the author's and committer's.
// Session links the trailers carry are attached to a declaration of the same
// agent where there is one. Duplicates are dropped and the list is capped at
// kMaxDeclarations.
std::vector<Declaration> combine(std::vector<Declaration> notes, std::vector<Declaration> trailers,
                                 std::vector<Declaration> identities);

// "agent" when any declaration names an agent, "human" when only known
// humans are declared, "unknown" otherwise.
std::string declaredKind(const std::vector<Declaration>& declarations);

nlohmann::json declarationJson(const Declaration& declaration);

}  // namespace gg::services::provenance
