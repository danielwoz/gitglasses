#include "services/notes/git_ai_note.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <utility>

namespace gg::services::notes {

namespace {

using Json = nlohmann::json;

// The schema major version this adapter reads. Minor and patch versions of
// the same major only add optional members.
constexpr std::string_view kSchemaPrefix = "authorship/";
constexpr int kReadableMajor = 3;

// Longest messages_url kept.
constexpr std::size_t kMaxUrlLength = 2048;

bool isHex(std::string_view text) {
  return !text.empty() && std::all_of(text.begin(), text.end(),
                                      [](unsigned char c) { return std::isxdigit(c) != 0; });
}

// "1-4,9,12-30": comma-separated line numbers and inclusive ranges.
bool isLineRanges(std::string_view text) {
  if (text.empty()) return false;
  bool digit = false;
  for (const char c : text) {
    if (std::isdigit(static_cast<unsigned char>(c)) != 0) {
      digit = true;
    } else if ((c == ',' || c == '-') && digit) {
      digit = false;
    } else {
      return false;
    }
  }
  return digit;
}

// The major version of "authorship/<major>.<minor>.<patch>", or -1.
int schemaMajor(std::string_view version) {
  if (version.substr(0, kSchemaPrefix.size()) != kSchemaPrefix) return -1;
  version.remove_prefix(kSchemaPrefix.size());
  const std::size_t dot = version.find('.');
  const std::string_view major = version.substr(0, dot);
  if (major.empty() || major.size() > 4) return -1;
  int value = 0;
  for (const char c : major) {
    if (std::isdigit(static_cast<unsigned char>(c)) == 0) return -1;
    value = value * 10 + (c - '0');
  }
  return value;
}

std::string stringMember(const Json& object, const char* key) {
  if (!object.is_object()) return {};
  const auto it = object.find(key);
  return it != object.end() && it->is_string() ? it->get<std::string>() : std::string();
}

// An http(s) URL without whitespace or control characters, or "".
std::string linkOrEmpty(std::string url) {
  if (url.size() > kMaxUrlLength) return {};
  std::string lower(url.substr(0, 8));
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (lower.rfind("https://", 0) != 0 && lower.rfind("http://", 0) != 0) return {};
  for (const char c : url) {
    if (static_cast<unsigned char>(c) <= 0x20 || c == 0x7f) return {};
  }
  return url;
}

GitAiAuthor agentFrom(const Json& record, bool legacy) {
  GitAiAuthor author;
  author.agent = true;
  const Json agentId = record.is_object() ? record.value("agent_id", Json::object()) : Json();
  author.tool = stringMember(agentId, "tool");
  author.model = stringMember(agentId, "model");
  author.sessionId = stringMember(agentId, "id");
  author.human = stringMember(record, "human_author");
  // Session records carry no transcript link; only legacy prompts may.
  if (legacy) author.messagesUrl = linkOrEmpty(stringMember(record, "messages_url"));
  return author;
}

// Splits on '\n', dropping a '\r' before it.
std::vector<std::string_view> splitLines(std::string_view text) {
  std::vector<std::string_view> lines;
  std::size_t start = 0;
  while (start <= text.size()) {
    std::size_t end = text.find('\n', start);
    if (end == std::string_view::npos) end = text.size();
    std::string_view line = text.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    lines.push_back(line);
    if (end == text.size()) break;
    start = end + 1;
  }
  return lines;
}

}  // namespace

GitAiNote parseGitAiNote(std::string_view text) {
  GitAiNote note;
  const std::vector<std::string_view> lines = splitLines(text);
  const auto divider = std::find(lines.begin(), lines.end(), std::string_view("---"));

  if (divider == lines.end()) {
    // Logs before 3.0.0 were a single JSON document; name their version
    // without reading them.
    const Json whole = Json::parse(text.begin(), text.end(), nullptr, false);
    if (whole.is_object() && whole.contains("schema_version")) {
      note.status = GitAiNoteStatus::UnsupportedVersion;
      note.schemaVersion = stringMember(whole, "schema_version");
    }
    return note;
  }

  const std::size_t metadataStart =
      static_cast<std::size_t>(divider->data() - text.data()) + divider->size();
  const std::string_view metadataText = text.substr(std::min(metadataStart, text.size()));
  const Json metadata = Json::parse(metadataText.begin(), metadataText.end(), nullptr, false);
  if (!metadata.is_object()) return note;
  note.schemaVersion = stringMember(metadata, "schema_version");
  if (note.schemaVersion.empty()) return note;
  if (schemaMajor(note.schemaVersion) != kReadableMajor) {
    note.status = GitAiNoteStatus::UnsupportedVersion;
    return note;
  }
  note.status = GitAiNoteStatus::Read;

  const auto mapMember = [&metadata](const char* key) {
    const auto it = metadata.find(key);
    return it != metadata.end() && it->is_object() ? *it : Json::object();
  };
  const Json prompts = mapMember("prompts");
  const Json sessions = mapMember("sessions");
  const Json humans = mapMember("humans");

  std::set<std::string> seen;
  for (auto it = lines.begin(); it != divider; ++it) {
    if (note.authors.size() >= kMaxGitAiAuthors) break;
    std::string_view line = *it;
    // File paths sit at the start of a line; attestations are indented by
    // exactly two spaces.
    if (line.size() < 3 || line.substr(0, 2) != "  " || line[2] == ' ') continue;
    line.remove_prefix(2);
    const std::size_t space = line.find(' ');
    if (space == std::string_view::npos) continue;
    const std::string_view key = line.substr(0, space);
    if (!isLineRanges(line.substr(space + 1))) continue;

    GitAiAuthor author;
    std::string identity;
    if (key.rfind("s_", 0) == 0) {
      const std::size_t separator = key.find("::");
      if (separator == std::string_view::npos || key.substr(separator + 2, 2) != "t_") continue;
      const std::string session(key.substr(0, separator));
      if (!sessions.contains(session)) continue;
      identity = "s:" + session;
      author = agentFrom(sessions[session], false);
    } else if (key.rfind("h_", 0) == 0) {
      const std::string human(key);
      if (!humans.contains(human)) continue;
      identity = "h:" + human;
      author.agent = false;
      author.human = stringMember(humans[human], "author");
    } else if (isHex(key)) {
      const std::string prompt(key);
      if (!prompts.contains(prompt)) continue;
      identity = "p:" + prompt;
      author = agentFrom(prompts[prompt], true);
    } else {
      continue;
    }
    if (seen.insert(identity).second) note.authors.push_back(std::move(author));
  }
  return note;
}

}  // namespace gg::services::notes
