#include "services/commit/provenance.h"

#include <algorithm>
#include <cctype>
#include <iterator>
#include <optional>
#include <set>
#include <string>

namespace gg::services::provenance {

namespace {

// --- Known agents -------------------------------------------------------------

struct Agent {
  std::string_view name;
  // The git-ai agent_id.tool naming the same agent, or "".
  std::string_view tool;
  // Co-author names carry the model after the agent's name ("Claude Opus 4.7").
  bool modelInName;
};

constexpr Agent kAgents[] = {
    {"Claude", "claude", true},
    {"Cursor", "cursor", false},
    {"GitHub Copilot", "copilot", false},
    {"Codex", "codex", false},
    {"Devin", "devin", false},
    {"Jules", "jules", false},
    {"Aider", "aider", false},
    {"Amp", "amp", false},
    {"Gemini", "gemini", false},
    {"Windsurf", "windsurf", false},
    {"Factory Droid", "droid", false},
    {"OpenCode", "opencode", false},
};

enum class Match {
  // The whole address, case-insensitively.
  Email,
  // A GitHub account's noreply address, <id>+<login>@users.noreply.github.com.
  // A login ending in [bot] is a GitHub App and matches with any id and on
  // GitHub Enterprise's users.noreply.<host> too; any other login is written
  // with its id, which tells the agent's account apart from a namesake.
  GitHubLogin,
  // The end of the display name.
  NameSuffix,
};

struct Identity {
  std::string_view agent;
  Match match;
  std::string_view value;  // lowercase
  unsigned roles;
};

constexpr unsigned kAnyRole = kAuthor | kCommitter | kCoAuthor;

// Identities agents commit or co-author under, as their own tools write them.
// Add a row to recognize another agent.
constexpr Identity kIdentities[] = {
    // Claude Code's trailer: "Co-Authored-By: Claude <model> <noreply@anthropic.com>".
    {"Claude", Match::Email, "noreply@anthropic.com", kAnyRole},
    // The Claude GitHub App (claude-code-action) and Claude's GitHub account,
    // which co-authors as anthropic-code-agent[bot].
    {"Claude", Match::GitHubLogin, "claude[bot]", kAnyRole},
    {"Claude", Match::GitHubLogin, "242468646+claude", kAnyRole},
    {"Claude", Match::GitHubLogin, "anthropic-code-agent[bot]", kAnyRole},
    // Cursor: cloud agents commit as "Cursor Agent", local agents add
    // "Co-authored-by: Cursor <cursoragent@cursor.com>".
    {"Cursor", Match::Email, "cursoragent@cursor.com", kAnyRole},
    // VS Code's AI co-author trailer.
    {"GitHub Copilot", Match::Email, "copilot@github.com", kAnyRole},
    // The Copilot coding agent commits as Copilot and co-authors as
    // copilot-swe-agent[bot], both under account 198982749.
    {"GitHub Copilot", Match::GitHubLogin, "198982749+copilot", kAnyRole},
    {"GitHub Copilot", Match::GitHubLogin, "copilot-swe-agent[bot]", kAnyRole},
    // Codex CLI's trailer, and the Codex GitHub App.
    {"Codex", Match::Email, "noreply@openai.com", kAnyRole},
    {"Codex", Match::GitHubLogin, "chatgpt-codex-connector[bot]", kAnyRole},
    {"Devin", Match::GitHubLogin, "devin-ai-integration[bot]", kAnyRole},
    {"Jules", Match::GitHubLogin, "google-labs-jules[bot]", kAnyRole},
    // Aider: "Co-authored-by: aider (<model>) <aider@aider.chat>", or
    // " (aider)" appended to the author's name. Aider appends it to the
    // committer of commits a person wrote too, so the committer is not read.
    {"Aider", Match::Email, "aider@aider.chat", kAnyRole},
    {"Aider", Match::NameSuffix, " (aider)", kAuthor},
    {"Amp", Match::Email, "amp@ampcode.com", kAnyRole},
};

// Trailers whose value names an AI tool: the Linux kernel's
// "Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL...]" and the Apache Software
// Foundation's "Generated-by: <tool>".
constexpr std::string_view kToolTrailers[] = {"assisted-by", "generated-by"};

constexpr std::string_view kCoAuthorTrailer = "co-authored-by";

// Trailers an agent adds to link the commit to its session.
struct SessionTrailer {
  std::string_view key;  // lowercase
  std::string_view agent;
};
constexpr SessionTrailer kSessionTrailers[] = {
    {"amp-thread-id", "Amp"},
    {"agent-logs-url", "GitHub Copilot"},
};

// Longest name and value reported.
constexpr std::size_t kMaxNameLength = 200;
constexpr std::size_t kMaxValueLength = 512;
constexpr std::size_t kMaxUrlLength = 2048;

// --- Text helpers ---------------------------------------------------------------

std::string lower(std::string_view text) {
  std::string out(text);
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

std::string_view trim(std::string_view text) {
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front())) != 0) {
    text.remove_prefix(1);
  }
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())) != 0) {
    text.remove_suffix(1);
  }
  return text;
}

bool startsWithIgnoringCase(std::string_view text, std::string_view prefix) {
  return text.size() >= prefix.size() && lower(text.substr(0, prefix.size())) == lower(prefix);
}

bool endsWithIgnoringCase(std::string_view text, std::string_view suffix) {
  return text.size() > suffix.size() &&
         lower(text.substr(text.size() - suffix.size())) == lower(suffix);
}

std::string clip(std::string_view text, std::size_t max) {
  return std::string(text.substr(0, max));
}

// "Name <email>" split into its parts; a value without "<" is all name.
std::pair<std::string_view, std::string_view> splitIdentity(std::string_view value) {
  const std::size_t open = value.rfind('<');
  const std::size_t close = value.rfind('>');
  if (open == std::string_view::npos || close == std::string_view::npos || close < open) {
    return {trim(value), {}};
  }
  return {trim(value.substr(0, open)), trim(value.substr(open + 1, close - open - 1))};
}

bool isLink(std::string_view url) {
  if (url.size() > kMaxUrlLength) return false;
  if (!startsWithIgnoringCase(url, "https://") && !startsWithIgnoringCase(url, "http://")) {
    return false;
  }
  return std::none_of(url.begin(), url.end(),
                      [](unsigned char c) { return c <= 0x20 || c == 0x7f; });
}

const Agent* findAgent(std::string_view name) {
  for (const Agent& agent : kAgents) {
    if (lower(agent.name) == lower(name)) return &agent;
  }
  return nullptr;
}

// The known agent a free-text tool name starts with ("Claude Code",
// "GitHub Copilot Chat"), or nullptr.
const Agent* agentNamedBy(std::string_view text) {
  for (const Agent& agent : kAgents) {
    for (const std::string_view word : {agent.name, agent.tool}) {
      if (word.empty() || !startsWithIgnoringCase(text, word)) continue;
      if (text.size() == word.size()) return &agent;
      const char next = text[word.size()];
      if (std::isalnum(static_cast<unsigned char>(next)) == 0) return &agent;
    }
  }
  return nullptr;
}

// The model a co-author name carries: "aider (gpt-4o)" or, for agents that
// write it after their own name, "Claude Opus 4.7".
std::string modelFromName(std::string_view name, const Agent* agent) {
  const std::size_t open = name.rfind('(');
  if (open != std::string_view::npos && !name.empty() && name.back() == ')') {
    return std::string(trim(name.substr(open + 1, name.size() - open - 2)));
  }
  if (agent && agent->modelInName && name.size() > agent->name.size() + 1 &&
      startsWithIgnoringCase(name, agent->name) && name[agent->name.size()] == ' ') {
    return std::string(trim(name.substr(agent->name.size() + 1)));
  }
  return {};
}

bool isGitHubNoreplyLogin(std::string_view email, std::string_view login) {
  const std::size_t at = email.rfind('@');
  if (at == std::string_view::npos) return false;
  const std::string_view local = email.substr(0, at);
  const std::string_view domain = email.substr(at + 1);
  const bool app = login.size() > 5 && login.substr(login.size() - 5) == "[bot]";
  if (app ? domain.rfind("users.noreply.", 0) != 0 : domain != "users.noreply.github.com") {
    return false;
  }
  if (local == login) return true;
  if (!app) return false;
  const std::size_t plus = local.find('+');
  if (plus == std::string_view::npos || plus == 0) return false;
  const std::string_view id = local.substr(0, plus);
  return std::all_of(id.begin(), id.end(), [](unsigned char c) { return std::isdigit(c) != 0; }) &&
         local.substr(plus + 1) == login;
}

const SessionTrailer* sessionTrailer(std::string_view key) {
  const std::string wanted = lower(key);
  for (const SessionTrailer& trailer : kSessionTrailers) {
    if (trailer.key == wanted) return &trailer;
  }
  return nullptr;
}

bool isToolTrailer(std::string_view key) {
  const std::string wanted = lower(key);
  return std::find(std::begin(kToolTrailers), std::end(kToolTrailers), wanted) !=
         std::end(kToolTrailers);
}

Declaration agentDeclaration(Source source, std::string name, std::string_view via,
                             std::string_view value) {
  Declaration declaration;
  declaration.source = source;
  declaration.kind = Kind::Agent;
  declaration.name = clip(name, kMaxNameLength);
  declaration.via = clip(via, kMaxNameLength);
  declaration.value = clip(value, kMaxValueLength);
  return declaration;
}

// An Assisted-by or Generated-by value as a declaration, if it names an AI
// tool.
std::optional<Declaration> toolTrailerDeclaration(std::string_view key, std::string_view value) {
  const auto [name, email] = splitIdentity(value);
  if (!email.empty()) {
    // A person's address names a person; only a known agent's counts.
    std::string agent = agentForIdentity(name, email, kCoAuthor);
    if (agent.empty()) return std::nullopt;
    Declaration declaration = agentDeclaration(Source::Trailer, agent, key, value);
    declaration.model = clip(modelFromName(name, findAgent(agent)), kMaxNameLength);
    return declaration;
  }
  if (name.empty()) return std::nullopt;
  // The kernel's form: the first word is AGENT:MODEL, the rest are tools.
  const std::string_view first = name.substr(0, name.find_first_of(" \t"));
  const std::size_t colon = first.find(':');
  if (colon != std::string_view::npos && colon > 0) {
    const std::string_view agentText = first.substr(0, colon);
    const Agent* known = agentNamedBy(agentText);
    Declaration declaration = agentDeclaration(
        Source::Trailer, known ? std::string(known->name) : std::string(agentText), key, value);
    declaration.model = clip(first.substr(colon + 1), kMaxNameLength);
    return declaration;
  }
  const Agent* known = agentNamedBy(name);
  return agentDeclaration(Source::Trailer, known ? std::string(known->name) : std::string(name),
                          key, value);
}

std::string dedupeKey(const Declaration& declaration) {
  return std::to_string(static_cast<int>(declaration.source)) + '\0' +
         std::to_string(static_cast<int>(declaration.kind)) + '\0' + lower(declaration.name) +
         '\0' + lower(declaration.via) + '\0' + lower(declaration.value);
}

}  // namespace

std::string agentForIdentity(std::string_view name, std::string_view email, Role role) {
  const std::string address = lower(trim(email));
  const std::string_view displayName = trim(name);
  for (const Identity& identity : kIdentities) {
    if ((identity.roles & role) == 0) continue;
    switch (identity.match) {
      case Match::Email:
        if (address == identity.value) return std::string(identity.agent);
        break;
      case Match::GitHubLogin:
        if (isGitHubNoreplyLogin(address, identity.value)) return std::string(identity.agent);
        break;
      case Match::NameSuffix:
        if (endsWithIgnoringCase(displayName, identity.value)) return std::string(identity.agent);
        break;
    }
  }
  return {};
}

std::string agentForTool(std::string_view tool) {
  const std::string wanted = lower(trim(tool));
  for (const Agent& agent : kAgents) {
    if (!agent.tool.empty() && agent.tool == wanted) return std::string(agent.name);
  }
  return std::string(trim(tool));
}

std::vector<Declaration> trailerDeclarations(
    const std::vector<std::pair<std::string, std::string>>& trailers) {
  std::vector<Declaration> declarations;
  for (const auto& [key, rawValue] : trailers) {
    const std::string_view value = trim(rawValue);
    if (lower(key) == kCoAuthorTrailer) {
      const auto [name, email] = splitIdentity(value);
      const std::string agent = agentForIdentity(name, email, kCoAuthor);
      if (agent.empty()) continue;
      Declaration declaration = agentDeclaration(Source::Trailer, agent, key, value);
      declaration.model = clip(modelFromName(name, findAgent(agent)), kMaxNameLength);
      declarations.push_back(std::move(declaration));
    } else if (isToolTrailer(key)) {
      if (auto declaration = toolTrailerDeclaration(key, value)) {
        declarations.push_back(std::move(*declaration));
      }
    } else if (const SessionTrailer* session = sessionTrailer(key)) {
      Declaration declaration =
          agentDeclaration(Source::Trailer, std::string(session->agent), key, value);
      if (isLink(value)) declaration.url = std::string(value);
      declarations.push_back(std::move(declaration));
    }
  }
  return declarations;
}

std::vector<Declaration> identityDeclarations(std::string_view name, std::string_view email,
                                              Role role) {
  const std::string agent = agentForIdentity(name, email, role);
  if (agent.empty()) return {};
  const std::string identity =
      email.empty() ? std::string(trim(name))
                    : std::string(trim(name)) + " <" + std::string(trim(email)) + ">";
  Declaration declaration = agentDeclaration(Source::Identity, agent,
                                             role == kCommitter ? "committer" : "author", identity);
  declaration.model = clip(modelFromName(trim(name), findAgent(agent)), kMaxNameLength);
  return {std::move(declaration)};
}

std::vector<Declaration> noteDeclarations(const notes::GitAiNote& note, std::string_view ref) {
  std::vector<Declaration> declarations;
  if (note.status != notes::GitAiNoteStatus::Read) return declarations;
  for (const notes::GitAiAuthor& author : note.authors) {
    Declaration declaration;
    declaration.source = Source::Notes;
    declaration.via = clip(ref, kMaxNameLength);
    if (author.agent) {
      declaration.kind = Kind::Agent;
      declaration.name =
          clip(author.tool.empty() ? std::string("AI agent") : agentForTool(author.tool),
               kMaxNameLength);
      declaration.model = clip(author.model, kMaxNameLength);
      declaration.value = clip(author.sessionId, kMaxValueLength);
      declaration.url = author.messagesUrl;
    } else {
      declaration.kind = Kind::Human;
      declaration.name = clip(author.human, kMaxNameLength);
      declaration.value = clip(author.human, kMaxValueLength);
    }
    declarations.push_back(std::move(declaration));
  }
  return declarations;
}

std::vector<Declaration> combine(std::vector<Declaration> notes, std::vector<Declaration> trailers,
                                 std::vector<Declaration> identities) {
  std::vector<Declaration> all;
  std::vector<Declaration> sessionLinks;
  std::set<std::string> seen;
  const auto add = [&](Declaration declaration) {
    if (seen.insert(dedupeKey(declaration)).second) all.push_back(std::move(declaration));
  };
  for (Declaration& declaration : notes) add(std::move(declaration));
  for (Declaration& declaration : trailers) {
    if (declaration.source == Source::Trailer && sessionTrailer(declaration.via)) {
      sessionLinks.push_back(std::move(declaration));
    } else {
      add(std::move(declaration));
    }
  }
  for (Declaration& declaration : identities) add(std::move(declaration));

  // A session link joins a declaration of its agent that has none yet; one
  // with nothing to join, or a second link of the same agent, stands alone.
  for (Declaration& link : sessionLinks) {
    if (!link.url.empty()) {
      const bool known = std::any_of(all.begin(), all.end(),
                                     [&](const Declaration& d) { return d.url == link.url; });
      if (known) continue;
      const auto target = std::find_if(all.begin(), all.end(), [&](const Declaration& d) {
        return d.kind == Kind::Agent && d.url.empty() && lower(d.name) == lower(link.name);
      });
      if (target != all.end()) {
        target->url = link.url;
        continue;
      }
    }
    add(std::move(link));
  }

  if (all.size() > kMaxDeclarations) all.resize(kMaxDeclarations);
  return all;
}

std::string declaredKind(const std::vector<Declaration>& declarations) {
  bool human = false;
  for (const Declaration& declaration : declarations) {
    if (declaration.kind == Kind::Agent) return "agent";
    human = true;
  }
  return human ? "human" : "unknown";
}

nlohmann::json declarationJson(const Declaration& declaration) {
  static constexpr const char* kSources[] = {"notes", "trailer", "identity"};
  nlohmann::json out = {{"source", kSources[static_cast<int>(declaration.source)]},
                        {"kind", declaration.kind == Kind::Agent ? "agent" : "human"},
                        {"name", declaration.name},
                        {"via", declaration.via},
                        {"value", declaration.value}};
  if (!declaration.model.empty()) out["model"] = declaration.model;
  if (!declaration.url.empty()) out["url"] = declaration.url;
  return out;
}

}  // namespace gg::services::provenance
