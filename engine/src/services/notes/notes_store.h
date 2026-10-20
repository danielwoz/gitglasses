#pragma once

#include <cstddef>
#include <list>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "core/repo.h"
#include "rpc/dispatcher.h"
#include "util/result.h"

namespace gg::services::notes {

// Largest note read whole; a bigger one is reported TooLarge and never
// loaded into a response.
inline constexpr std::size_t kMaxNoteBytes = 4 * 1024 * 1024;

enum class NoteState {
  // The ref attaches no note to the commit.
  Absent,
  Present,
  // Longer than kMaxNoteBytes.
  TooLarge,
  // The note exists but its blob could not be read (for instance one a
  // partial clone left out). Not cached, so a later fetch can supply it.
  Unreadable,
};

struct Note {
  NoteState state = NoteState::Absent;
  std::string text;
};

// Note texts already read, keyed by repository, notes ref, the commit the ref
// pointed at and the annotated commit. A ref that moves changes the key, so an
// entry never goes stale; entries are only evicted, least recently used first,
// once the byte budget is spent. Thread-safe.
class NotesCache {
 public:
  explicit NotesCache(std::size_t byteBudget = 16u << 20) : budget_(byteBudget) {}

  // Fills `note` and returns true when the key is cached.
  bool get(const std::string& key, Note& note);
  void put(const std::string& key, const Note& note);

  static std::string makeKey(const std::string& repoId, const std::string& ref,
                             const std::string& tip, const std::string& sha);

  // Drops every entry belonging to a repository (repo/close).
  void dropRepo(const std::string& repoId);

 private:
  void eraseLocked(
      std::map<std::string, std::pair<Note, std::list<std::string>::iterator>>::iterator it);

  std::mutex mutex_;
  std::size_t budget_;
  std::size_t used_ = 0;
  std::list<std::string> lru_;  // front = most recent
  std::map<std::string, std::pair<Note, std::list<std::string>::iterator>> entries_;
};

// The `key` param: a non-empty array of at most `max` full, lowercase commit
// shas. Throws InvalidParams otherwise.
std::vector<std::string> requireCommitShas(const rpc::Json& params, const char* key,
                                           std::size_t max);

// True for a full ref name under refs/notes/ that git accepts.
bool isNotesRef(const std::string& ref);

// The commit `ref` points at, or "" when the ref does not exist.
Result<std::string> notesTip(const core::Repo& repo, const std::string& ref);

// The note `ref` attaches to commit `sha` (40 hex), read through `cache`.
// `tip` is notesTip()'s answer for the same ref and must not be empty.
Note readNote(const core::Repo& repo, NotesCache& cache, const std::string& repoId,
              const std::string& ref, const std::string& tip, const std::string& sha);

}  // namespace gg::services::notes
