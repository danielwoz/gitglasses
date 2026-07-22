#include "services/graph/graph_methods.h"

#include <git2.h>

#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <queue>
#include <set>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

namespace gg::services {

namespace {

// Sanity ceiling on page sizes so a bad client cannot request an unbounded
// response frame.
constexpr std::int64_t kMaxLimit = 100000;

// Sha of the synthetic uncommitted-changes row (protocol UNCOMMITTED_SHA).
constexpr const char* kWipSha = "0000000000000000000000000000000000000000";

struct CommitDeleter {
  void operator()(git_commit* commit) const { git_commit_free(commit); }
};
using CommitPtr = std::unique_ptr<git_commit, CommitDeleter>;

struct ReferenceDeleter {
  void operator()(git_reference* ref) const { git_reference_free(ref); }
};
using ReferencePtr = std::unique_ptr<git_reference, ReferenceDeleter>;

struct BranchIteratorDeleter {
  void operator()(git_branch_iterator* iter) const { git_branch_iterator_free(iter); }
};
using BranchIteratorPtr = std::unique_ptr<git_branch_iterator, BranchIteratorDeleter>;

struct ReferenceIteratorDeleter {
  void operator()(git_reference_iterator* iter) const { git_reference_iterator_free(iter); }
};
using ReferenceIteratorPtr = std::unique_ptr<git_reference_iterator, ReferenceIteratorDeleter>;

struct StatusListDeleter {
  void operator()(git_status_list* list) const { git_status_list_free(list); }
};
using StatusListPtr = std::unique_ptr<git_status_list, StatusListDeleter>;

// Always reports GitError: an unresolvable object is GIT_ENOTFOUND to
// libgit2, but not a missing repository.
Error graphGitError(const std::string& context) {
  const git_error* err = git_error_last();
  const std::string detail = err && err->message ? err->message : "unknown libgit2 error";
  return {ErrorCode::GitError, context + ": " + detail};
}

std::string oidToHex(const git_oid& oid) {
  char hex[GIT_OID_HEXSZ + 1] = {};
  git_oid_fmt(hex, &oid);
  return hex;
}

// Sha of the commit a ref ultimately points at (peels annotated tags and
// symbolic refs). Empty when the ref does not resolve to a commit.
std::string commitShaOf(git_reference* ref) {
  git_object* obj = nullptr;
  if (git_reference_peel(&obj, ref, GIT_OBJECT_COMMIT) != 0) return {};
  std::unique_ptr<git_object, decltype(&git_object_free)> guard(obj, git_object_free);
  return oidToHex(*git_object_id(obj));
}

rpc::Json signatureJson(const git_signature* sig) {
  return {{"name", sig && sig->name ? sig->name : ""},
          {"email", sig && sig->email ? sig->email : ""},
          {"time", sig ? static_cast<std::int64_t>(sig->when.time) : 0}};
}

// --- base64 (opaque cursor encoding) ---------------------------------------

constexpr char kBase64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::string& in) {
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  while (i + 3 <= in.size()) {
    const unsigned v = (static_cast<unsigned char>(in[i]) << 16) |
                       (static_cast<unsigned char>(in[i + 1]) << 8) |
                       static_cast<unsigned char>(in[i + 2]);
    out += kBase64Chars[(v >> 18) & 63];
    out += kBase64Chars[(v >> 12) & 63];
    out += kBase64Chars[(v >> 6) & 63];
    out += kBase64Chars[v & 63];
    i += 3;
  }
  const size_t rest = in.size() - i;
  if (rest == 1) {
    const unsigned v = static_cast<unsigned char>(in[i]) << 16;
    out += kBase64Chars[(v >> 18) & 63];
    out += kBase64Chars[(v >> 12) & 63];
    out += "==";
  } else if (rest == 2) {
    const unsigned v = (static_cast<unsigned char>(in[i]) << 16) |
                       (static_cast<unsigned char>(in[i + 1]) << 8);
    out += kBase64Chars[(v >> 18) & 63];
    out += kBase64Chars[(v >> 12) & 63];
    out += kBase64Chars[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

std::optional<std::string> base64Decode(const std::string& in) {
  if (in.size() % 4 != 0) return std::nullopt;
  int table[256];
  std::fill(std::begin(table), std::end(table), -1);
  for (int c = 0; c < 64; ++c) table[static_cast<unsigned char>(kBase64Chars[c])] = c;
  std::string out;
  out.reserve(in.size() / 4 * 3);
  for (size_t i = 0; i < in.size(); i += 4) {
    int vals[4];
    int pad = 0;
    for (size_t j = 0; j < 4; ++j) {
      const char c = in[i + j];
      if (c == '=' && i + 4 == in.size() && j >= 2) {
        vals[j] = 0;
        ++pad;
        continue;
      }
      vals[j] = table[static_cast<unsigned char>(c)];
      if (vals[j] < 0 || pad > 0) return std::nullopt;
    }
    const unsigned v = static_cast<unsigned>((vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) |
                                             vals[3]);
    out += static_cast<char>((v >> 16) & 0xff);
    if (pad < 2) out += static_cast<char>((v >> 8) & 0xff);
    if (pad < 1) out += static_cast<char>(v & 0xff);
  }
  return out;
}

// --- lane layout (docs/specs/commit-graph-lanes.md) -------------------------

// Ordered list of active lanes; each holds the sha it waits for (the next
// expected commit in that lane), or nothing when free.
struct LaneState {
  std::vector<std::optional<std::string>> lanes;

  // Lowest-index free lane, reusing freed lanes before growing.
  std::size_t allocate(const std::string& sha) {
    for (std::size_t i = 0; i < lanes.size(); ++i) {
      if (!lanes[i]) {
        lanes[i] = sha;
        return i;
      }
    }
    lanes.emplace_back(sha);
    return lanes.size() - 1;
  }

  // Trailing free lanes carry no information; dropping them keeps cursors
  // compact without affecting lowest-free-index allocation.
  void shrink() {
    while (!lanes.empty() && !lanes.back()) lanes.pop_back();
  }
};

struct RowLayout {
  std::size_t lane = 0;
  rpc::Json edges;
};

// Applies one row to the active-lane state. Edge order within a row is
// deterministic: mergeIn (ascending fromLane), then branchOut (parent order),
// then pass-through line edges (ascending lane).
RowLayout layoutRow(LaneState& state, const std::string& sha,
                    const std::vector<std::string>& parents) {
  auto& lanes = state.lanes;
  std::vector<std::size_t> waiting;
  for (std::size_t i = 0; i < lanes.size(); ++i) {
    if (lanes[i] && *lanes[i] == sha) waiting.push_back(i);
  }

  rpc::Json edges = rpc::Json::array();
  std::set<std::size_t> involved;
  std::size_t lane = 0;
  if (waiting.empty()) {
    lane = state.allocate(sha);
  } else {
    lane = waiting[0];
    for (std::size_t j = 1; j < waiting.size(); ++j) {
      edges.push_back({{"fromLane", waiting[j]}, {"toLane", lane}, {"kind", "mergeIn"}});
      lanes[waiting[j]].reset();
      involved.insert(waiting[j]);
    }
  }
  involved.insert(lane);

  if (parents.empty()) {
    lanes[lane].reset();  // a root commit frees its lane after the row
  } else {
    lanes[lane] = parents[0];  // first parent continues in this lane
    for (std::size_t pi = 1; pi < parents.size(); ++pi) {
      std::optional<std::size_t> target;
      for (std::size_t i = 0; i < lanes.size(); ++i) {
        if (i != lane && lanes[i] && *lanes[i] == parents[pi]) {
          target = i;
          break;
        }
      }
      if (!target) target = state.allocate(parents[pi]);
      edges.push_back({{"fromLane", lane}, {"toLane", *target}, {"kind", "branchOut"}});
      involved.insert(*target);
    }
  }

  for (std::size_t i = 0; i < lanes.size(); ++i) {
    if (lanes[i] && involved.find(i) == involved.end()) {
      edges.push_back({{"fromLane", i}, {"toLane", i}, {"kind", "line"}});
    }
  }
  state.shrink();
  return {lane, std::move(edges)};
}

// --- refs snapshot ----------------------------------------------------------

struct StashInfo {
  std::size_t index = 0;
  std::string sha;
  std::string message;
};

struct GraphSnapshot {
  std::string headSha;  // empty when HEAD is unborn
  std::vector<std::string> tips;  // deduplicated walk roots
  std::map<std::string, rpc::Json> refsBySha;  // decoration arrays, pre-ordered
  std::vector<StashInfo> stashes;  // newest first (stash@{0} first)
  std::uint64_t generation = 0;
};

void fnvMix(std::uint64_t& hash, std::string_view text) {
  for (const char c : text) {
    hash ^= static_cast<unsigned char>(c);
    hash *= 1099511628211ull;
  }
}

// Collects HEAD + branch/remote/tag/stash pointers. `generation` is a stable
// 53-bit fingerprint of this snapshot: the watcher's per-repo generation
// counter is not reachable from ServiceContext, so instead of a monotonic
// counter the fingerprint stays constant while refs are unchanged (pages of
// one logical snapshot agree) and changes whenever any ref moves.
Result<GraphSnapshot> buildSnapshot(const core::Repo& repo) {
  GraphSnapshot snap;
  git_repository* raw = repo.raw();
  std::uint64_t hash = 1469598103934665603ull;

  auto head = repo.head();
  if (!head) return head.error();
  std::set<std::string> tipSet;
  // (kind rank, sort name, sha, decoration): rank orders head < branch <
  // remote < tag; names sort alphabetically within a rank.
  std::vector<std::tuple<int, std::string, std::string, rpc::Json>> decorations;

  if (!head.value().unborn && !head.value().oid.empty()) {
    snap.headSha = head.value().oid;
    tipSet.insert(snap.headSha);
    decorations.emplace_back(0, "HEAD", snap.headSha,
                             rpc::Json{{"name", "HEAD"}, {"kind", "head"}});
    fnvMix(hash, "HEAD:" + snap.headSha);
  }

  // Local branches, with upstream ahead/behind.
  {
    git_branch_iterator* rawIter = nullptr;
    if (git_branch_iterator_new(&rawIter, raw, GIT_BRANCH_LOCAL) != 0) {
      return graphGitError("list local branches");
    }
    BranchIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    git_branch_t type;
    while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
      ReferencePtr ref(rawRef);
      const char* name = nullptr;
      if (git_branch_name(&name, ref.get()) != 0) continue;
      const std::string sha = commitShaOf(ref.get());
      if (sha.empty()) continue;
      rpc::Json decoration = {{"name", name}, {"kind", "branch"}};
      git_reference* rawUpstream = nullptr;
      if (git_branch_upstream(&rawUpstream, ref.get()) == 0) {
        ReferencePtr upstream(rawUpstream);
        const std::string upstreamSha = commitShaOf(upstream.get());
        const char* upstreamName = git_reference_shorthand(upstream.get());
        if (!upstreamSha.empty() && upstreamName) {
          git_oid localOid, upstreamOid;
          size_t ahead = 0, behind = 0;
          if (git_oid_fromstr(&localOid, sha.c_str()) == 0 &&
              git_oid_fromstr(&upstreamOid, upstreamSha.c_str()) == 0 &&
              git_graph_ahead_behind(&ahead, &behind, raw, &localOid, &upstreamOid) == 0) {
            decoration["upstream"] = {{"name", upstreamName},
                                      {"ahead", ahead},
                                      {"behind", behind}};
          }
        }
      }
      fnvMix(hash, "b:" + std::string(name) + ":" + sha + ":" + decoration.dump());
      decorations.emplace_back(1, name, sha, std::move(decoration));
      tipSet.insert(sha);
    }
  }

  // Remote branches (walk tips too, like `git log --remotes`).
  {
    git_branch_iterator* rawIter = nullptr;
    if (git_branch_iterator_new(&rawIter, raw, GIT_BRANCH_REMOTE) != 0) {
      return graphGitError("list remote branches");
    }
    BranchIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    git_branch_t type;
    while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
      ReferencePtr ref(rawRef);
      // Skip symbolic refs like refs/remotes/origin/HEAD.
      if (git_reference_type(ref.get()) == GIT_REFERENCE_SYMBOLIC) continue;
      const char* name = nullptr;
      if (git_branch_name(&name, ref.get()) != 0) continue;
      const std::string sha = commitShaOf(ref.get());
      if (sha.empty()) continue;
      fnvMix(hash, "r:" + std::string(name) + ":" + sha);
      decorations.emplace_back(2, name, sha, rpc::Json{{"name", name}, {"kind", "remote"}});
      tipSet.insert(sha);
    }
  }

  // Tags decorate rows but do not extend the walk.
  {
    git_reference_iterator* rawIter = nullptr;
    if (git_reference_iterator_glob_new(&rawIter, raw, "refs/tags/*") != 0) {
      return graphGitError("list tags");
    }
    ReferenceIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    while (git_reference_next(&rawRef, iter.get()) == 0) {
      ReferencePtr ref(rawRef);
      const std::string sha = commitShaOf(ref.get());
      if (sha.empty()) continue;  // tag of a tree/blob: not a commit ref
      const std::string name = git_reference_shorthand(ref.get());
      fnvMix(hash, "t:" + name + ":" + sha);
      decorations.emplace_back(3, name, sha, rpc::Json{{"name", name}, {"kind", "tag"}});
    }
  }

  // Stashes (rows are synthesized separately; also part of the fingerprint).
  {
    auto callback = [](size_t index, const char* message, const git_oid* stashId,
                       void* payload) -> int {
      auto& out = *static_cast<std::vector<StashInfo>*>(payload);
      out.push_back({index, oidToHex(*stashId), message ? message : ""});
      return 0;
    };
    if (git_stash_foreach(raw, callback, &snap.stashes) != 0) {
      return graphGitError("list stashes");
    }
    for (const auto& stash : snap.stashes) fnvMix(hash, "s:" + stash.sha);
  }

  std::sort(decorations.begin(), decorations.end(),
            [](const auto& a, const auto& b) {
              return std::tie(std::get<0>(a), std::get<1>(a), std::get<2>(a)) <
                     std::tie(std::get<0>(b), std::get<1>(b), std::get<2>(b));
            });
  for (auto& decoration : decorations) {
    rpc::Json& list =
        snap.refsBySha.try_emplace(std::get<2>(decoration), rpc::Json::array()).first->second;
    list.push_back(std::move(std::get<3>(decoration)));
  }
  snap.tips.assign(tipSet.begin(), tipSet.end());
  snap.generation = hash & ((1ull << 53) - 1);
  return snap;
}

// --- commit DAG collection --------------------------------------------------

struct Node {
  std::vector<std::string> parents;
  std::int64_t time = 0;  // committer time (topological tie-break)
  int pendingChildren = 0;
};

using NodeMap = std::unordered_map<std::string, Node>;

Result<NodeMap> collectNodes(const core::Repo& repo, const std::vector<std::string>& tips,
                             const CancelToken& token) {
  NodeMap nodes;
  std::vector<std::string> stack = tips;
  while (!stack.empty()) {
    token.throwIfCancelled();
    const std::string sha = std::move(stack.back());
    stack.pop_back();
    if (nodes.find(sha) != nodes.end()) continue;
    git_oid oid;
    if (git_oid_fromstr(&oid, sha.c_str()) != 0) {
      return graphGitError("parse oid " + sha);
    }
    git_commit* rawCommit = nullptr;
    if (git_commit_lookup(&rawCommit, repo.raw(), &oid) != 0) {
      return graphGitError("lookup commit " + sha);
    }
    CommitPtr commit(rawCommit);
    Node node;
    node.time = static_cast<std::int64_t>(git_commit_time(commit.get()));
    const unsigned int parentCount = git_commit_parentcount(commit.get());
    node.parents.reserve(parentCount);
    for (unsigned int i = 0; i < parentCount; ++i) {
      node.parents.push_back(oidToHex(*git_commit_parent_id(commit.get(), i)));
    }
    for (const auto& parent : node.parents) stack.push_back(parent);
    nodes.emplace(sha, std::move(node));
  }
  for (auto& entry : nodes) {
    for (const auto& parent : entry.second.parents) {
      auto it = nodes.find(parent);
      if (it != nodes.end()) ++it->second.pendingChildren;
    }
  }
  return nodes;
}

// Any staged, unstaged, or untracked change makes the workdir "dirty" for the
// synthetic WIP row.
Result<bool> workdirDirty(const core::Repo& repo) {
  if (repo.workdir().empty()) return false;
  git_status_options opts;
  git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
  opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS;
  git_status_list* rawList = nullptr;
  if (git_status_list_new(&rawList, repo.raw(), &opts) != 0) {
    return graphGitError("workdir status");
  }
  StatusListPtr list(rawList);
  return git_status_list_entrycount(list.get()) > 0;
}

std::int64_t requireLimit(const rpc::Json& params) {
  const std::int64_t limit = params.value("limit", std::int64_t{0});
  if (limit <= 0) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, "'limit' must be a positive integer"}};
  }
  return std::min(limit, kMaxLimit);
}

struct Cursor {
  std::size_t pos = 0;
  LaneState lanes;
};

Cursor decodeCursor(const std::string& encoded) {
  const auto raw = base64Decode(encoded);
  if (raw) {
    const rpc::Json parsed = rpc::Json::parse(*raw, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_object() && parsed.value("pos", std::int64_t{-1}) >= 0 &&
        parsed.contains("lanes") && parsed["lanes"].is_array()) {
      Cursor cursor;
      cursor.pos = parsed["pos"].get<std::size_t>();
      for (const auto& lane : parsed["lanes"]) {
        if (lane.is_null()) {
          cursor.lanes.lanes.emplace_back(std::nullopt);
        } else if (lane.is_string()) {
          cursor.lanes.lanes.emplace_back(lane.get<std::string>());
        } else {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
        }
      }
      return cursor;
    }
  }
  throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
}

std::string encodeCursor(std::size_t pos, const LaneState& state) {
  rpc::Json lanes = rpc::Json::array();
  for (const auto& lane : state.lanes) {
    lanes.push_back(lane ? rpc::Json(*lane) : rpc::Json());
  }
  return base64Encode(rpc::Json{{"pos", pos}, {"lanes", std::move(lanes)}}.dump());
}

}  // namespace

void registerGraphMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "graph/rows",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::int64_t limit = requireLimit(params);
        const rpc::Json include = params.value("include", rpc::Json::object());
        const bool includeStashes = include.value("stashes", false);
        const bool includeWip = include.value("wip", false);
        Cursor cursor;
        if (params.contains("cursor") && params["cursor"].is_string()) {
          cursor = decodeCursor(params["cursor"].get<std::string>());
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto snapshot = buildSnapshot(repo.value());
        if (!snapshot) throw rpc::HandlerError{{snapshot.error()}};
        const GraphSnapshot& snap = snapshot.value();

        rpc::Json rows = rpc::Json::array();
        if (snap.tips.empty()) {
          return {{"rows", std::move(rows)}, {"generation", snap.generation}};  // unborn HEAD
        }

        auto nodes = collectNodes(repo.value(), snap.tips, token);
        if (!nodes) throw rpc::HandlerError{{nodes.error()}};

        // Stash rows precede the commit they were stashed on (the stash
        // commit's first parent). Stashes whose base is not reachable from any
        // walked tip produce no row.
        std::map<std::string, std::vector<StashInfo>> stashesByBase;
        if (includeStashes) {
          for (const auto& stash : snap.stashes) {
            git_oid oid;
            git_commit* rawCommit = nullptr;
            if (git_oid_fromstr(&oid, stash.sha.c_str()) != 0 ||
                git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
              throw rpc::HandlerError{{graphGitError("lookup stash " + stash.sha)}};
            }
            CommitPtr commit(rawCommit);
            if (git_commit_parentcount(commit.get()) == 0) continue;
            const std::string base = oidToHex(*git_commit_parent_id(commit.get(), 0));
            if (nodes.value().find(base) != nodes.value().end()) {
              stashesByBase[base].push_back(stash);  // foreach order: index asc
            }
          }
        }

        bool wantWip = false;
        if (includeWip && !snap.headSha.empty()) {
          auto dirty = workdirDirty(repo.value());
          if (!dirty) throw rpc::HandlerError{{dirty.error()}};
          wantWip = dirty.value();
        }

        LaneState laneState = std::move(cursor.lanes);
        const std::size_t startPos = cursor.pos;
        std::size_t pos = 0;
        std::optional<std::string> nextCursor;

        auto lookupCommit = [&](const std::string& sha) -> CommitPtr {
          git_oid oid;
          git_commit* rawCommit = nullptr;
          if (git_oid_fromstr(&oid, sha.c_str()) != 0 ||
              git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{graphGitError("lookup commit " + sha)}};
          }
          return CommitPtr(rawCommit);
        };

        // Emits one row of the deterministic sequence. Rows before the cursor
        // are skipped without touching lane state (the cursor carries it);
        // returns false once the page is full, capturing the next cursor.
        auto emitRow = [&](const std::string& sha, const std::vector<std::string>& parents,
                           const char* kind, const StashInfo* stash) -> bool {
          if (pos < startPos) {
            ++pos;
            return true;
          }
          if (static_cast<std::int64_t>(rows.size()) >= limit) {
            nextCursor = encodeCursor(pos, laneState);
            return false;
          }
          RowLayout layout = layoutRow(laneState, sha, parents);
          rpc::Json row = {{"sha", sha},           {"parents", parents},
                           {"lane", layout.lane},  {"laneEdges", std::move(layout.edges)},
                           {"kind", kind}};
          if (stash) {
            CommitPtr commit = lookupCommit(sha);
            row["author"] = signatureJson(git_commit_author(commit.get()));
            row["time"] = static_cast<std::int64_t>(git_commit_time(commit.get()));
            row["summary"] = stash->message;
            row["refs"] = rpc::Json::array(
                {{{"name", "stash@{" + std::to_string(stash->index) + "}"}, {"kind", "stash"}}});
          } else if (sha == kWipSha) {
            // Synthetic values keep identical repo states byte-identical.
            row["author"] = rpc::Json{{"name", ""}, {"email", ""}, {"time", 0}};
            row["time"] = 0;
            row["summary"] = "Uncommitted changes";
            row["refs"] = rpc::Json::array();
          } else {
            CommitPtr commit = lookupCommit(sha);
            row["author"] = signatureJson(git_commit_author(commit.get()));
            row["time"] = static_cast<std::int64_t>(git_commit_time(commit.get()));
            const char* summary = git_commit_summary(commit.get());
            row["summary"] = summary ? summary : "";
            auto refs = snap.refsBySha.find(sha);
            row["refs"] = refs != snap.refsBySha.end() ? refs->second : rpc::Json::array();
          }
          rows.push_back(std::move(row));
          ++pos;
          return true;
        };

        // Topological walk: children before parents, ties by committer time
        // (newest first) then sha (lexicographic) — fully deterministic.
        struct ReadyOrder {
          bool operator()(const std::pair<std::int64_t, std::string>& a,
                          const std::pair<std::int64_t, std::string>& b) const {
            if (a.first != b.first) return a.first < b.first;
            return a.second > b.second;
          }
        };
        std::priority_queue<std::pair<std::int64_t, std::string>,
                            std::vector<std::pair<std::int64_t, std::string>>, ReadyOrder>
            ready;
        for (const auto& [sha, node] : nodes.value()) {
          if (node.pendingChildren == 0) ready.emplace(node.time, sha);
        }

        bool more = true;
        if (wantWip) more = emitRow(kWipSha, {snap.headSha}, "wip", nullptr);
        while (more && !ready.empty()) {
          token.throwIfCancelled();
          const std::string sha = ready.top().second;
          ready.pop();
          if (auto it = stashesByBase.find(sha); it != stashesByBase.end()) {
            for (const auto& stash : it->second) {
              more = emitRow(stash.sha, {sha}, "stash", &stash);
              if (!more) break;
            }
          }
          if (!more) break;
          more = emitRow(sha, nodes.value().at(sha).parents, "commit", nullptr);
          if (!more) break;
          for (const auto& parent : nodes.value().at(sha).parents) {
            Node& parentNode = nodes.value().at(parent);
            if (--parentNode.pendingChildren == 0) ready.emplace(parentNode.time, parent);
          }
        }

        rpc::Json result = {{"rows", std::move(rows)}, {"generation", snap.generation}};
        if (nextCursor) result["nextCursor"] = *nextCursor;
        return result;
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
