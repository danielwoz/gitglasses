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

enum class Entry {
  // The notes tree has no entry for the commit.
  None,
  // It has one.
  Present,
  // A tree on the way could not be read, so whether it has one is unknown.
  Unknown,
};

// Whether the notes tree of `tip` holds an entry for `sha`. git stores a note
// at the commit's full hex name, or under two-character fanout directories
// ("ab/cdef...", "ab/cd/ef..."), so each level is tried both ways.
Entry noteEntry(const core::Repo& repo, const std::string& tip, const std::string& sha) {
  git_oid tipId;
  git_commit* rawCommit = nullptr;
  if (git_oid_fromstr(&tipId, tip.c_str()) != 0 ||
      git_commit_lookup(&rawCommit, repo.raw(), &tipId) != 0) {
    return Entry::Unknown;
  }
  core::CommitPtr commit(rawCommit);
  git_tree* rawTree = nullptr;
  if (git_commit_tree(&rawTree, commit.get()) != 0) return Entry::Unknown;
  core::TreePtr tree(rawTree);
  std::string_view rest = sha;
  while (!rest.empty()) {
    const git_tree_entry* entry = git_tree_entry_byname(tree.get(), std::string(rest).c_str());
    if (entry && git_tree_entry_type(entry) == GIT_OBJECT_BLOB) return Entry::Present;
    if (rest.size() <= 2) return Entry::None;
    const git_tree_entry* fanout =
        git_tree_entry_byname(tree.get(), std::string(rest.substr(0, 2)).c_str());
    if (!fanout || git_tree_entry_type(fanout) != GIT_OBJECT_TREE) return Entry::None;
    git_tree* rawSubtree = nullptr;
    if (git_tree_lookup(&rawSubtree, repo.raw(), git_tree_entry_id(fanout)) != 0) {
      return Entry::Unknown;
    }
    tree.reset(rawSubtree);
    rest.remove_prefix(2);
  }
  return Entry::None;
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

std::string remoteNotesRef(std::string_view ref, std::string_view remote) {
  std::string out(ref);
  out.append("-remote/");
  for (const char c : remote) {
    const bool kept = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                      c == '-' || c == '_';
    out.push_back(kept ? c : '_');
  }
  return out;
}

std::vector<NotesRefTip> notesSources(const core::Repo& repo, const std::string& ref) {
  std::vector<NotesRefTip> sources;
  const auto add = [&](const std::string& name) {
    auto tip = notesTip(repo, name);
    if (!tip) {
      spdlog::warn("notes: {} is unreadable, so its notes are skipped: {}", name,
                   tip.error().message);
    } else if (!tip.value().empty()) {
      sources.push_back({name, tip.value()});
    }
  };
  add(ref);

  std::vector<std::string> remotes;
  const std::string glob = ref + "-remote/*";
  git_reference_iterator* rawIter = nullptr;
  if (git_reference_iterator_glob_new(&rawIter, repo.raw(), glob.c_str()) == 0) {
    core::ReferenceIteratorPtr iter(rawIter);
    const char* name = nullptr;
    while (git_reference_next_name(&name, iter.get()) == 0) remotes.emplace_back(name);
  }
  std::sort(remotes.begin(), remotes.end());
  if (remotes.size() > kMaxRemoteNotesRefs) remotes.resize(kMaxRemoteNotesRefs);
  for (const std::string& name : remotes) add(name);
  return sources;
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
    // git_note_read says the same when the commit has no note and when its
    // note's blob is missing; only the tree tells them apart.
    switch (noteEntry(repo, tip, sha)) {
      case Entry::None:
        cache.put(key, note);
        break;
      case Entry::Present:
        spdlog::debug("notes: the {} note of {} is not in the object database", ref, sha);
        note.state = NoteState::Unreadable;
        break;
      case Entry::Unknown:
        // Without the tree there is no telling whether a note exists, so
        // none is claimed; nothing is cached, and the next read looks again.
        spdlog::debug("notes: the {} tree at {} is not in the object database", ref, tip);
        break;
    }
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
