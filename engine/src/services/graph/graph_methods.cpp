#include "services/graph/graph_methods.h"

#include <git2.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#include "cache/graph_cache.h"
#include "core/git2.h"
#include "core/git2_json.h"
#include "services/params.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

// Sha of the synthetic uncommitted-changes row (protocol UNCOMMITTED_SHA).
constexpr const char* kWipSha = "0000000000000000000000000000000000000000";

// --- base64 (opaque cursor encoding) ---------------------------------------

constexpr char kBase64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Reverse of kBase64Chars, indexed by byte value; -1 outside the alphabet.
constexpr std::array<int, 256> makeBase64Table() {
  std::array<int, 256> table{};
  for (int& entry : table) entry = -1;
  for (int c = 0; c < 64; ++c) table[static_cast<unsigned char>(kBase64Chars[c])] = c;
  return table;
}
constexpr std::array<int, 256> kBase64Table = makeBase64Table();

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
  std::string out;
  out.reserve(in.size() / 4 * 3);
  for (size_t i = 0; i < in.size(); i += 4) {
    int vals[4];
    int pad = 0;
    for (size_t j = 0; j < 4; ++j) {
      const char c = in[i + j];
      // '=' is padding only in the last quad's third or fourth position.
      if (c == '=' && i + 4 == in.size() && j >= 2) {
        vals[j] = 0;
        ++pad;
        continue;
      }
      // pad > 0 here means an alphabet character follows a pad character,
      // which no encoder produces.
      vals[j] = kBase64Table[static_cast<unsigned char>(c)];
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

rpc::Json laneEdge(std::size_t from, std::size_t to, const char* kind) {
  return {{"fromLane", from}, {"toLane", to}, {"kind", kind}};
}

// Applies one row to the active-lane state. Edge order within a row is
// deterministic: lineIn, mergeIn (ascending fromLane), one edge per parent in
// parent order (lineOut when the parent continues in this lane, branchOut
// otherwise), then pass-through line edges (ascending fromLane; a line whose
// toLane differs moves into that lane by the row bottom).
RowLayout layoutRow(LaneState& state, const std::string& sha,
                    const std::vector<std::string>& parents) {
  auto& lanes = state.lanes;
  std::vector<std::size_t> waiting;
  for (std::size_t i = 0; i < lanes.size(); ++i) {
    if (lanes[i] && *lanes[i] == sha) waiting.push_back(i);
  }

  rpc::Json edges = rpc::Json::array();
  std::size_t lane = 0;
  if (waiting.empty()) {
    lane = state.allocate(sha);
  } else {
    lane = waiting[0];
    // The child above already drew down to this row's top: continue it into
    // the dot.
    edges.push_back(laneEdge(lane, lane, "lineIn"));
    for (std::size_t j = 1; j < waiting.size(); ++j) {
      edges.push_back(laneEdge(waiting[j], lane, "mergeIn"));
      lanes[waiting[j]].reset();
    }
  }

  // Lanes that enter the row from above and do not end in the dot pass
  // through it, each to the column it continues in below.
  std::vector<std::size_t> passing;
  for (std::size_t i = 0; i < lanes.size(); ++i) {
    if (i != lane && lanes[i]) passing.push_back(i);
  }
  std::map<std::size_t, std::size_t> continuesIn;
  for (const std::size_t i : passing) continuesIn[i] = i;
  auto waitingFor = [&](const std::string& parent) -> std::optional<std::size_t> {
    for (const std::size_t i : passing) {
      if (lanes[i] && *lanes[i] == parent) return i;
    }
    return std::nullopt;
  };

  if (parents.empty()) {
    lanes[lane].reset();  // a root commit frees its lane after the row
  } else {
    // Every line leading to the first parent becomes one, in the leftmost of
    // their lanes, as git log --graph collapses them. Without this a branch
    // forked from a commit shown far below would hold its own column all
    // the way down to it.
    std::vector<std::size_t> sameParent;
    for (const std::size_t i : passing) {
      if (*lanes[i] == parents[0]) sameParent.push_back(i);
    }
    const std::size_t keep = sameParent.empty() ? lane : std::min(lane, sameParent.front());
    if (keep == lane) {
      lanes[lane] = parents[0];  // first parent continues in this lane
      edges.push_back(laneEdge(lane, lane, "lineOut"));
    } else {
      lanes[lane].reset();
      edges.push_back(laneEdge(lane, keep, "branchOut"));
    }
    for (const std::size_t i : sameParent) {
      if (i == keep) continue;
      lanes[i].reset();
      continuesIn[i] = keep;
    }
  }
  for (std::size_t pi = 1; pi < parents.size(); ++pi) {
    std::optional<std::size_t> target = waitingFor(parents[pi]);
    if (!target) target = state.allocate(parents[pi]);
    // The own lane, freed by a join above, can be the lowest free lane.
    edges.push_back(laneEdge(lane, *target, *target == lane ? "lineOut" : "branchOut"));
  }

  for (const auto& [from, to] : continuesIn) edges.push_back(laneEdge(from, to, "line"));
  state.shrink();
  return {lane, std::move(edges)};
}

// --- refs snapshot ----------------------------------------------------------

using cache::GraphStash;

struct GraphSnapshot {
  std::string headSha;  // empty when HEAD is unborn
  std::vector<std::string> tips;  // deduplicated walk roots
  std::map<std::string, rpc::Json> refsBySha;  // decoration arrays, pre-ordered
  std::vector<GraphStash> stashes;             // newest first (stash@{0} first)
  std::uint64_t refsFingerprint = 0;
};

void fnvMix(std::uint64_t& hash, std::string_view text) {
  for (const char c : text) {
    hash ^= static_cast<unsigned char>(c);
    hash *= 1099511628211ull;
  }
}

// Collects HEAD + branch/remote/tag/stash pointers. `refsFingerprint` is a
// stable 53-bit hash of this snapshot: it stays constant while refs are
// unchanged, so the pages of one logical snapshot agree, and changes whenever
// any ref moves. It is a content hash, not the monotonic per-repo counter
// repo/didChange carries.
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
      return core::gitError("list local branches");
    }
    core::BranchIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    git_branch_t type;
    while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
      core::ReferencePtr ref(rawRef);
      const char* name = nullptr;
      if (git_branch_name(&name, ref.get()) != 0) continue;
      const std::string sha = core::commitShaOf(ref.get());
      if (sha.empty()) continue;
      rpc::Json decoration = {{"name", name}, {"kind", "branch"}};
      git_reference* rawUpstream = nullptr;
      if (git_branch_upstream(&rawUpstream, ref.get()) == 0) {
        core::ReferencePtr upstream(rawUpstream);
        const std::string upstreamSha = core::commitShaOf(upstream.get());
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
      return core::gitError("list remote branches");
    }
    core::BranchIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    git_branch_t type;
    while (git_branch_next(&rawRef, &type, iter.get()) == 0) {
      core::ReferencePtr ref(rawRef);
      // Skip symbolic refs like refs/remotes/origin/HEAD.
      if (git_reference_type(ref.get()) == GIT_REFERENCE_SYMBOLIC) continue;
      const char* name = nullptr;
      if (git_branch_name(&name, ref.get()) != 0) continue;
      const std::string sha = core::commitShaOf(ref.get());
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
      return core::gitError("list tags");
    }
    core::ReferenceIteratorPtr iter(rawIter);
    git_reference* rawRef = nullptr;
    while (git_reference_next(&rawRef, iter.get()) == 0) {
      core::ReferencePtr ref(rawRef);
      const std::string sha = core::commitShaOf(ref.get());
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
      auto& out = *static_cast<std::vector<GraphStash>*>(payload);
      out.push_back({index, core::oidToHex(*stashId), message ? message : ""});
      return 0;
    };
    if (git_stash_foreach(raw, callback, &snap.stashes) != 0) {
      return core::gitError("list stashes");
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
  snap.refsFingerprint = hash & ((1ull << 53) - 1);
  return snap;
}

// --- commit DAG collection --------------------------------------------------

// git_oid is a 20-byte POD, so it keys the walk directly: collection needs no
// hex at all, and lookups hash 8 bytes instead of 40. Hex appears once per
// commit and once per parent edge, when the ordered plan is materialized.
struct OidHash {
  std::size_t operator()(const git_oid& oid) const noexcept {
    std::size_t hash = 0;
    std::memcpy(&hash, oid.id, sizeof(hash));
    return hash;
  }
};

struct OidEq {
  bool operator()(const git_oid& a, const git_oid& b) const noexcept {
    return git_oid_equal(&a, &b) != 0;
  }
};

struct Node {
  std::vector<git_oid> parents;
  std::int64_t time = 0;  // committer time (orders the branch tips)
  int pendingChildren = 0;
};

using NodeMap = std::unordered_map<git_oid, Node, OidHash, OidEq>;

Result<NodeMap> collectNodes(const core::Repo& repo, const std::vector<std::string>& tips,
                             const CancelToken& token) {
  NodeMap nodes;
  std::vector<git_oid> stack;
  stack.reserve(tips.size());
  for (const auto& tip : tips) {
    git_oid oid;
    if (git_oid_fromstr(&oid, tip.c_str()) != 0) return core::gitError("parse oid " + tip);
    stack.push_back(oid);
  }
  while (!stack.empty()) {
    token.throwIfCancelled();
    const git_oid oid = stack.back();
    stack.pop_back();
    if (nodes.find(oid) != nodes.end()) continue;
    git_commit* rawCommit = nullptr;
    if (git_commit_lookup(&rawCommit, repo.raw(), &oid) != 0) {
      return core::gitError("lookup commit " + core::oidToHex(oid));
    }
    core::CommitPtr commit(rawCommit);
    Node node;
    node.time = static_cast<std::int64_t>(git_commit_time(commit.get()));
    const unsigned int parentCount = git_commit_parentcount(commit.get());
    node.parents.reserve(parentCount);
    for (unsigned int i = 0; i < parentCount; ++i) {
      node.parents.push_back(*git_commit_parent_id(commit.get(), i));
    }
    for (const auto& parent : node.parents) stack.push_back(parent);
    nodes.emplace(oid, std::move(node));
  }
  for (auto& entry : nodes) {
    for (const auto& parent : entry.second.parents) {
      const auto it = nodes.find(parent);
      if (it != nodes.end()) ++it->second.pendingChildren;
    }
  }
  return nodes;
}

// Walks the DAG once and materializes the row order a page slices from, the
// way `git log --topo-order` orders a graph: children before parents, and each
// branch's commits kept together. Ready commits form a stack, so a commit's
// parents come out right after it; a merge's later parents are pushed last
// and come out first, which shows the merged branch directly below the merge
// and lets its lane close before the first-parent line moves on. Branch tips
// start newest first by committer time, then by sha (lexicographic), so the
// order is fully deterministic.
std::vector<cache::GraphPlanRow> buildOrder(NodeMap& nodes, const CancelToken& token) {
  // A ready commit carries its own oid, so popping it needs no hex lookup;
  // sha is kept only for the tip order and is moved into the emitted row.
  struct Ready {
    std::int64_t time;
    std::string sha;
    git_oid oid;
  };
  std::vector<Ready> ready;
  for (const auto& [oid, node] : nodes) {
    if (node.pendingChildren == 0) ready.push_back({node.time, core::oidToHex(oid), oid});
  }
  // The stack pops from the back: oldest tips first in the vector, so the
  // newest (and on equal times the smallest sha) is popped first.
  std::sort(ready.begin(), ready.end(), [](const Ready& a, const Ready& b) {
    if (a.time != b.time) return a.time < b.time;
    return a.sha > b.sha;
  });

  std::vector<cache::GraphPlanRow> order;
  order.reserve(nodes.size());
  while (!ready.empty()) {
    token.throwIfCancelled();
    Ready top = std::move(ready.back());
    ready.pop_back();
    Node& node = nodes.at(top.oid);

    cache::GraphPlanRow row;
    row.sha = std::move(top.sha);
    row.parents.reserve(node.parents.size());
    for (const auto& parent : node.parents) row.parents.push_back(core::oidToHex(parent));
    // Parents that just lost their last child become ready, reusing the hex
    // already produced for the edge above.
    for (std::size_t i = 0; i < node.parents.size(); ++i) {
      const auto it = nodes.find(node.parents[i]);
      if (it != nodes.end() && --it->second.pendingChildren == 0) {
        ready.push_back({it->second.time, row.parents[i], node.parents[i]});
      }
    }
    order.push_back(std::move(row));
  }
  return order;
}

// Any staged, unstaged, or untracked change makes the workdir "dirty" for the
// synthetic WIP row, judged the way status/summary judges it: skip-worktree
// entries and submodules with only local edits do not count, and filtered
// files libgit2 calls modified count only when git, which cleans them first,
// agrees. Untracked directories are not descended into: one untracked entry
// settles the question.
Result<bool> workdirDirty(const core::Repo& repo, bool cliAvailable, const CancelToken& token) {
  if (repo.workdir().empty()) return false;
  git_status_options opts;
  git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
  opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED;
  git_status_list* rawList = nullptr;
  if (git_status_list_new(&rawList, repo.raw(), &opts) != 0) {
    return core::gitError("workdir status");
  }
  core::StatusListPtr list(rawList);
  auto index = status_detail::readIndex(repo.raw());
  if (!index) return index.error();

  // Staged changes, conflicts and untracked files need no second opinion.
  constexpr unsigned int kAlwaysDirty = GIT_STATUS_INDEX_NEW | GIT_STATUS_INDEX_MODIFIED |
                                        GIT_STATUS_INDEX_DELETED | GIT_STATUS_INDEX_RENAMED |
                                        GIT_STATUS_INDEX_TYPECHANGE | GIT_STATUS_CONFLICTED |
                                        GIT_STATUS_WT_NEW;
  std::vector<status_detail::CleanRecheck> rechecks;
  const size_t count = git_status_list_entrycount(list.get());
  for (size_t i = 0; i < count; ++i) {
    token.throwIfCancelled();
    const git_status_entry* entry = git_status_byindex(list.get(), i);
    if (!entry || entry->status == GIT_STATUS_CURRENT) continue;
    if (entry->status & kAlwaysDirty) return true;
    if (!entry->index_to_workdir || status_detail::workdirSideHidden(index.value().get(), *entry)) {
      continue;
    }
    if (cliAvailable && status_detail::needsCleanRecheck(repo.raw(), *entry)) {
      rechecks.push_back(
          {entry->index_to_workdir->new_file.path, entry->index_to_workdir->old_file.id});
      continue;
    }
    return true;
  }
  if (rechecks.empty()) return false;
  const std::vector<bool> changed = status_detail::confirmCleanChanges(repo, rechecks, token);
  return std::find(changed.begin(), changed.end(), true) != changed.end();
}

// Paging state between pages of one snapshot: the next row's position in the
// sequence, the active lanes, the fingerprint of the walk the positions index
// into, and whether that sequence opened with the WIP row.
struct Cursor {
  std::size_t pos = 0;
  LaneState lanes;
  std::optional<std::uint64_t> fingerprint;
  bool wip = false;
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
      if (const auto fp = parsed.find("fp"); fp != parsed.end()) {
        if (!fp->is_number_unsigned()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
        }
        cursor.fingerprint = fp->get<std::uint64_t>();
      }
      cursor.wip = parsed.value("wip", false);
      return cursor;
    }
  }
  throw rpc::HandlerError{{ErrorCode::InvalidParams, "invalid cursor"}};
}

std::string encodeCursor(std::size_t pos, const LaneState& state, std::uint64_t fingerprint,
                         bool wip) {
  rpc::Json lanes = rpc::Json::array();
  for (const auto& lane : state.lanes) {
    lanes.push_back(lane ? rpc::Json(*lane) : rpc::Json());
  }
  return base64Encode(rpc::Json{
      {"pos", pos},
      {"lanes", std::move(lanes)},
      {"fp", fingerprint},
      {"wip", wip}}.dump());
}

// The walk roots a `refs` filter names, resolved to commits, deduplicated and
// sorted. Revisions that no longer resolve (a branch deleted since the filter
// was chosen) are skipped.
std::vector<std::string> filteredTips(const core::Repo& repo,
                                      const std::vector<std::string>& revisions) {
  std::set<std::string> tips;
  for (const auto& revision : revisions) {
    auto commit = status_detail::resolveCommit(repo, revision);
    if (commit) tips.insert(core::oidToHex(*git_commit_id(commit.value().get())));
  }
  return {tips.begin(), tips.end()};
}

// A filtered walk is a different sequence from the full one, so its
// fingerprint also covers the roots it starts from.
std::uint64_t filteredFingerprint(std::uint64_t refsFingerprint,
                                  const std::vector<std::string>& tips) {
  std::uint64_t hash = 1469598103934665603ull;
  fnvMix(hash, "refs:" + std::to_string(refsFingerprint));
  for (const auto& tip : tips) fnvMix(hash, "f:" + tip);
  return hash & ((1ull << 53) - 1);
}

// The walk a graph/rows or graph/find request covers: the refs snapshot, the
// roots (every branch tip plus HEAD, or what the `refs` filter names), and
// the fingerprint that identifies the sequence.
struct Walk {
  GraphSnapshot snap;
  std::vector<std::string> tips;
  std::uint64_t fingerprint = 0;
};

// A request's `refs` filter, when it has one.
std::optional<std::vector<std::string>> refsFilter(const rpc::Json& params) {
  if (!params.contains("refs")) return std::nullopt;
  return requireStringArray(params, "refs");
}

Walk openWalk(const core::Repo& repo, const std::optional<std::vector<std::string>>& filter) {
  auto snapshot = buildSnapshot(repo);
  if (!snapshot) throw rpc::HandlerError{{snapshot.error()}};
  Walk walk{std::move(snapshot.value()), {}, 0};
  walk.tips = filter ? filteredTips(repo, *filter) : walk.snap.tips;
  walk.fingerprint = filter ? filteredFingerprint(walk.snap.refsFingerprint, walk.tips)
                            : walk.snap.refsFingerprint;
  return walk;
}

// The commit order of a walk with tips. It depends only on the refs (and the
// filter), which the fingerprint hashes, so it is built once and cached.
std::shared_ptr<const cache::GraphPlan> planFor(ServiceContext& context, const core::Repo& repo,
                                                const std::string& repoId, const Walk& walk,
                                                const CancelToken& token) {
  const std::string cacheKey = cache::GraphCache::makeKey(repoId, walk.fingerprint);
  std::shared_ptr<const cache::GraphPlan> plan = context.graphCache.get(cacheKey);
  if (plan) return plan;

  auto nodes = collectNodes(repo, walk.tips, token);
  if (!nodes) throw rpc::HandlerError{{nodes.error()}};

  auto built = std::make_shared<cache::GraphPlan>();
  built->commits = buildOrder(nodes.value(), token);
  built->stashes = walk.snap.stashes;

  // Stash rows precede the commit they were stashed on (the stash commit's
  // first parent). Stashes whose base is not reachable from any walked tip
  // produce no row.
  for (std::size_t i = 0; i < built->stashes.size(); ++i) {
    const std::string& stashSha = built->stashes[i].sha;
    git_oid oid;
    git_commit* rawCommit = nullptr;
    if (git_oid_fromstr(&oid, stashSha.c_str()) != 0 ||
        git_commit_lookup(&rawCommit, repo.raw(), &oid) != 0) {
      throw rpc::HandlerError{{core::gitError("lookup stash " + stashSha)}};
    }
    core::CommitPtr commit(rawCommit);
    if (git_commit_parentcount(commit.get()) == 0) continue;
    const git_oid* base = git_commit_parent_id(commit.get(), 0);
    if (nodes.value().find(*base) != nodes.value().end()) {
      built->stashesByBase[core::oidToHex(*base)].push_back(i);  // index asc
    }
  }
  context.graphCache.put(cacheKey, built);
  return built;
}

// Visits the rows of a walk that follow the uncommitted-changes row, in the
// order graph/rows emits them: the cached commit order, with each commit's
// stash rows (when included) right before it. `visit(sha, parents, kind,
// stash)` returns false to stop.
template <typename Visit>
void forEachRow(const cache::GraphPlan& plan, bool includeStashes, const CancelToken& token,
                Visit&& visit) {
  for (const auto& row : plan.commits) {
    token.throwIfCancelled();
    if (includeStashes) {
      const auto it = plan.stashesByBase.find(row.sha);
      if (it != plan.stashesByBase.end()) {
        for (const std::size_t index : it->second) {
          const GraphStash& stash = plan.stashes[index];
          if (!visit(stash.sha, std::vector<std::string>{row.sha}, "stash", &stash)) return;
        }
      }
    }
    if (!visit(row.sha, row.parents, "commit", nullptr)) return;
  }
}

core::CommitPtr lookupCommit(const core::Repo& repo, const std::string& sha) {
  git_oid oid;
  git_commit* rawCommit = nullptr;
  if (git_oid_fromstr(&oid, sha.c_str()) != 0 ||
      git_commit_lookup(&rawCommit, repo.raw(), &oid) != 0) {
    throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
  }
  return core::CommitPtr(rawCommit);
}

// --- find --------------------------------------------------------------------

char lowerAscii(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c; }

std::string lowerAscii(std::string_view text) {
  std::string lowered(text);
  for (char& c : lowered) c = lowerAscii(c);
  return lowered;
}

// Case-insensitive (ASCII) substring test; `needle` is already lowercase.
bool containsFolded(std::string_view haystack, std::string_view needle) {
  return std::search(haystack.begin(), haystack.end(), needle.begin(), needle.end(),
                     [](char a, char b) { return lowerAscii(a) == b; }) != haystack.end();
}

bool containsFolded(const char* haystack, std::string_view needle) {
  return haystack != nullptr && containsFolded(std::string_view(haystack), needle);
}

// Whether a row matches the find box: a sha prefix, a ref the row shows, or
// text in the message (the stash's own message for a stash row) or the
// author's name or email. The cheap tests run before the commit is read.
bool rowMatches(const core::Repo& repo, const GraphSnapshot& snap, const std::string& sha,
                const GraphStash* stash, std::string_view needle) {
  if (sha.compare(0, needle.size(), needle) == 0) return true;
  if (stash) {
    if (containsFolded("stash@{" + std::to_string(stash->index) + "}", needle) ||
        containsFolded(stash->message, needle)) {
      return true;
    }
  } else if (const auto refs = snap.refsBySha.find(sha); refs != snap.refsBySha.end()) {
    for (const auto& ref : refs->second) {
      if (containsFolded(ref.value("name", ""), needle)) return true;
    }
  }
  core::CommitPtr commit = lookupCommit(repo, sha);
  if (!stash && containsFolded(git_commit_message(commit.get()), needle)) return true;
  const git_signature* author = git_commit_author(commit.get());
  return author && (containsFolded(author->name, needle) || containsFolded(author->email, needle));
}

}  // namespace

void registerGraphMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "graph/rows",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::int64_t limit = pageLimit(params);
        const rpc::Json include = optionalObject(params, "include");
        const bool includeStashes = include.value("stashes", false);
        const bool includeWip = include.value("wip", false);
        const auto filter = refsFilter(params);
        Cursor cursor;
        if (const std::string encoded = optionalString(params, "cursor"); !encoded.empty()) {
          cursor = decodeCursor(encoded);
        }
        const std::string repoId = params.value("repoId", "");
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const Walk walk = openWalk(repo.value(), filter);
        const GraphSnapshot& snap = walk.snap;
        const std::vector<std::string>& tips = walk.tips;
        const std::uint64_t fingerprint = walk.fingerprint;
        // Positions in a cursor index into one walk; once any ref moves they
        // would name other rows, with lane state that no longer fits them.
        if (cursor.fingerprint && *cursor.fingerprint != fingerprint) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams,
               "stale cursor: the refs changed since the first page; request it again"}};
        }

        rpc::Json rows = rpc::Json::array();
        if (tips.empty()) {
          // Unborn HEAD, or a filter naming nothing that exists: no tips to
          // walk.
          return {{"rows", std::move(rows)}, {"refsFingerprint", fingerprint}};
        }

        // Page 0 builds the whole walk and later pages slice it.
        const std::shared_ptr<const cache::GraphPlan> plan =
            planFor(context, repo.value(), repoId, walk, token);

        // Only page 0 can carry the WIP row, so only page 0 pays for the
        // status scan; later pages learn from the cursor whether the sequence
        // opened with it. The row hangs off HEAD, so a filtered walk carries it
        // only when HEAD is one of its roots.
        bool wantWip = cursor.wip;
        if (includeWip && cursor.pos == 0 && !snap.headSha.empty() &&
            std::binary_search(tips.begin(), tips.end(), snap.headSha)) {
          auto dirty = workdirDirty(repo.value(), context.cliAvailable, token);
          if (!dirty) throw rpc::HandlerError{{dirty.error()}};
          wantWip = dirty.value();
        }

        LaneState laneState = std::move(cursor.lanes);
        const std::size_t startPos = cursor.pos;
        std::size_t pos = 0;
        std::optional<std::string> nextCursor;

        // Emits one row of the deterministic sequence. Rows before the cursor
        // are skipped without touching lane state (the cursor carries it);
        // returns false once the page is full, capturing the next cursor.
        auto emitRow = [&](const std::string& sha, const std::vector<std::string>& parents,
                           const char* kind, const GraphStash* stash) -> bool {
          if (pos < startPos) {
            ++pos;
            return true;
          }
          if (static_cast<std::int64_t>(rows.size()) >= limit) {
            nextCursor = encodeCursor(pos, laneState, fingerprint, wantWip);
            return false;
          }
          RowLayout layout = layoutRow(laneState, sha, parents);
          rpc::Json row = {{"sha", sha},           {"parents", parents},
                           {"lane", layout.lane},  {"laneEdges", std::move(layout.edges)},
                           {"kind", kind}};
          if (stash) {
            core::CommitPtr commit = lookupCommit(repo.value(), sha);
            row["author"] = core::signatureJson(git_commit_author(commit.get()));
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
            core::CommitPtr commit = lookupCommit(repo.value(), sha);
            row["author"] = core::signatureJson(git_commit_author(commit.get()));
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

        // Emission follows the cached order, with stash rows inserted ahead of
        // the commit they were stashed on.
        if (!wantWip || emitRow(kWipSha, {snap.headSha}, "wip", nullptr)) {
          forEachRow(*plan, includeStashes, token, emitRow);
        }

        rpc::Json result = {{"rows", std::move(rows)}, {"refsFingerprint", fingerprint}};
        if (nextCursor) result["nextCursor"] = *nextCursor;
        return result;
      },
      rpc::Mode::Concurrent);

  dispatcher.method(
      "graph/find",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::int64_t limit = pageLimit(params);
        const std::string query = requireString(params, "query");
        if (query.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "query must not be empty"}};
        }
        const bool includeStashes = optionalObject(params, "include").value("stashes", false);
        const auto filter = refsFilter(params);
        const std::string repoId = params.value("repoId", "");
        auto repo = context.registry.open(repoId);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const Walk walk = openWalk(repo.value(), filter);
        rpc::Json matches = rpc::Json::array();
        bool truncated = false;
        if (!walk.tips.empty()) {
          const std::shared_ptr<const cache::GraphPlan> plan =
              planFor(context, repo.value(), repoId, walk, token);
          const std::string needle = lowerAscii(query);
          std::size_t index = 0;
          forEachRow(*plan, includeStashes, token,
                     [&](const std::string& sha, const std::vector<std::string>&, const char*,
                         const GraphStash* stash) {
                       const std::size_t row = index++;
                       if (!rowMatches(repo.value(), walk.snap, sha, stash, needle)) return true;
                       if (static_cast<std::int64_t>(matches.size()) >= limit) {
                         truncated = true;
                         return false;
                       }
                       matches.push_back({{"sha", sha}, {"index", row}});
                       return true;
                     });
        }
        return {{"matches", std::move(matches)},
                {"truncated", truncated},
                {"refsFingerprint", walk.fingerprint}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
