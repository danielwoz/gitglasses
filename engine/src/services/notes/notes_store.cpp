#include "services/notes/notes_store.h"

#include <git2.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <utility>

#include "core/git2.h"
#include "services/params.h"

namespace gg::services::notes {

namespace {

// Bookkeeping charged per entry on top of its text.
constexpr std::size_t kEntryOverhead = 256;

std::size_t entryBytes(const std::string& key, const Note& note) {
  return key.size() + note.text.size() + kEntryOverhead;
}

}  // namespace

std::string NotesCache::makeKey(const std::string& repoId, const std::string& ref,
                                const std::string& tip, const std::string& sha) {
  std::string key;
  key.reserve(repoId.size() + ref.size() + tip.size() + sha.size() + 3);
  key.append(repoId).push_back('\0');
  key.append(ref).push_back('\0');
  key.append(tip).push_back('\0');
  key.append(sha);
  return key;
}

bool NotesCache::get(const std::string& key, Note& note) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = entries_.find(key);
  if (it == entries_.end()) return false;
  lru_.splice(lru_.begin(), lru_, it->second.second);
  note = it->second.first;
  return true;
}

void NotesCache::put(const std::string& key, const Note& note) {
  const std::size_t bytes = entryBytes(key, note);
  if (bytes > budget_) return;
  std::lock_guard<std::mutex> lock(mutex_);
  const auto existing = entries_.find(key);
  if (existing != entries_.end()) eraseLocked(existing);
  lru_.push_front(key);
  entries_.emplace(key, std::make_pair(note, lru_.begin()));
  used_ += bytes;
  while (used_ > budget_ && !lru_.empty()) eraseLocked(entries_.find(lru_.back()));
}

void NotesCache::dropRepo(const std::string& repoId) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string prefix = repoId + '\0';
  auto it = entries_.lower_bound(prefix);
  while (it != entries_.end() && it->first.compare(0, prefix.size(), prefix) == 0) {
    auto next = std::next(it);
    eraseLocked(it);
    it = next;
  }
}

void NotesCache::eraseLocked(
    std::map<std::string, std::pair<Note, std::list<std::string>::iterator>>::iterator it) {
  used_ -= entryBytes(it->first, it->second.first);
  lru_.erase(it->second.second);
  entries_.erase(it);
}

std::vector<std::string> requireCommitShas(const rpc::Json& params, const char* key,
                                           std::size_t max) {
  std::vector<std::string> shas = requireStringArray(params, key);
  const auto reject = [key](const std::string& what) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, std::string("'") + key + "' " + what}};
  };
  if (shas.size() > max) reject("may list at most " + std::to_string(max) + " commits");
  for (const std::string& sha : shas) {
    const bool full = sha.size() == 40 && std::all_of(sha.begin(), sha.end(), [](char c) {
                        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                      });
    if (!full) reject("entries must be full lowercase commit shas");
  }
  return shas;
}

bool isNotesRef(const std::string& ref) {
  if (ref.rfind("refs/notes/", 0) != 0 || ref.size() <= std::strlen("refs/notes/")) return false;
  int valid = 0;
  return git_reference_name_is_valid(&valid, ref.c_str()) == 0 && valid != 0;
}

Result<std::string> notesTip(const core::Repo& repo, const std::string& ref) {
  git_oid oid;
  const int rc = git_reference_name_to_id(&oid, repo.raw(), ref.c_str());
  if (rc == GIT_ENOTFOUND) return std::string();
  if (rc != 0) return core::gitError("resolve " + ref);
  return core::oidToHex(oid);
}

Note readNote(const core::Repo& repo, NotesCache& cache, const std::string& repoId,
              const std::string& ref, const std::string& tip, const std::string& sha) {
  const std::string key = NotesCache::makeKey(repoId, ref, tip, sha);
  Note note;
  if (cache.get(key, note)) return note;

  git_oid oid;
  if (git_oid_fromstr(&oid, sha.c_str()) != 0) return note;
  git_note* raw = nullptr;
  const int rc = git_note_read(&raw, repo.raw(), ref.c_str(), &oid);
  if (rc == GIT_ENOTFOUND) {
    cache.put(key, note);
    return note;
  }
  if (rc != 0) {
    const git_error* error = git_error_last();
    spdlog::warn("notes: cannot read the {} note of {}: {}", ref, sha,
                 error && error->message ? error->message : "unknown error");
    note.state = NoteState::Unreadable;
    return note;
  }
  std::unique_ptr<git_note, decltype(&git_note_free)> owned(raw, git_note_free);
  const char* message = git_note_message(owned.get());
  const std::size_t length = message ? std::strlen(message) : 0;
  if (length > kMaxNoteBytes) {
    note.state = NoteState::TooLarge;
  } else {
    note.state = NoteState::Present;
    note.text.assign(message ? message : "", length);
  }
  cache.put(key, note);
  return note;
}

}  // namespace gg::services::notes
