#include "services/graph/graph_methods.h"

#include <git2.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
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

#include "cache/graph_cache.h"
#include "core/git2.h"
#include "core/git2_json.h"
#include "services/params.h"

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
      if (c == '=' && i + 4 == in.size() && j >= 2) {
        vals[j] = 0;
        ++pad;
        continue;
      }
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

using cache::GraphStash;

struct GraphSnapshot {
  std::string headSha;  // empty when HEAD is unborn
  std::vector<std::string> tips;  // deduplicated walk roots
  std::map<std::string, rpc::Json> refsBySha;  // decoration arrays, pre-ordered
  std::vector<GraphStash> stashes;  // newest first (stash@{0} first)
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
  std::int64_t time = 0;  // committer time (topological tie-break)
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

// Walks the DAG once and materializes the row order a page slices from.
// Topological: children before parents, ties by committer time (newest first)
// then sha (lexicographic) — fully deterministic.
std::vector<cache::GraphPlanRow> buildOrder(NodeMap& nodes, const CancelToken& token) {
  // A ready commit carries its own oid, so popping it needs no hex lookup;
  // sha is kept only for the tie-break and is moved into the emitted row.
  struct Ready {
    std::int64_t time;
    std::string sha;
    git_oid oid;
  };
  struct ReadyOrder {
    bool operator()(const Ready& a, const Ready& b) const {
      if (a.time != b.time) return a.time < b.time;
      return a.sha > b.sha;
    }
  };
  std::priority_queue<Ready, std::vector<Ready>, ReadyOrder> ready;
  for (const auto& [oid, node] : nodes) {
    if (node.pendingChildren == 0) ready.push({node.time, core::oidToHex(oid), oid});
  }

  std::vector<cache::GraphPlanRow> order;
  order.reserve(nodes.size());
  while (!ready.empty()) {
    token.throwIfCancelled();
    const Ready top = ready.top();
    ready.pop();
    Node& node = nodes.at(top.oid);

    cache::GraphPlanRow row;
    row.sha = top.sha;
    row.parents.reserve(node.parents.size());
    for (const auto& parent : node.parents) row.parents.push_back(core::oidToHex(parent));
    // Parents that just lost their last child become ready, reusing the hex
    // already produced for the edge above.
    for (std::size_t i = 0; i < node.parents.size(); ++i) {
      const auto it = nodes.find(node.parents[i]);
      if (it != nodes.end() && --it->second.pendingChildren == 0) {
        ready.push({it->second.time, row.parents[i], node.parents[i]});
      }
    }
    order.push_back(std::move(row));
  }
  return order;
}

// Any staged, unstaged, or untracked change makes the workdir "dirty" for the
// synthetic WIP row. Stops at the first entry: one changed path settles the
// question, and untracked directories are not descended into for the same
// reason.
Result<bool> workdirDirty(const core::Repo& repo) {
  if (repo.workdir().empty()) return false;
  git_status_options opts;
  git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
  opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED;
  bool dirty = false;
  const auto callback = [](const char*, unsigned int, void* payload) -> int {
    *static_cast<bool*>(payload) = true;
    return 1;  // nonzero stops the iteration
  };
  const int rc = git_status_foreach_ext(repo.raw(), &opts, callback, &dirty);
  // The early stop is reported as the callback's return value, not an error.
  if (rc != 0 && rc != 1) return core::gitError("workdir status");
  return dirty;
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
        const std::int64_t limit = pageLimit(params);
        const rpc::Json include = optionalObject(params, "include");
        const bool includeStashes = include.value("stashes", false);
        const bool includeWip = include.value("wip", false);
        Cursor cursor;
        if (const std::string encoded = optionalString(params, "cursor"); !encoded.empty()) {
          cursor = decodeCursor(encoded);
        }
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto snapshot = buildSnapshot(repo.value());
        if (!snapshot) throw rpc::HandlerError{{snapshot.error()}};
        const GraphSnapshot& snap = snapshot.value();

        rpc::Json rows = rpc::Json::array();
        if (snap.tips.empty()) {
          // Unborn HEAD: no tips to walk.
          return {{"rows", std::move(rows)}, {"refsFingerprint", snap.refsFingerprint}};
        }

        // The whole walk depends only on the refs, which `refsFingerprint`
        // hashes, so page 0 builds it and later pages slice it.
        const std::string cacheKey =
            cache::GraphCache::makeKey(params.value("repoId", ""), snap.refsFingerprint);
        std::shared_ptr<const cache::GraphPlan> plan = context.graphCache.get(cacheKey);
        if (!plan) {
          auto nodes = collectNodes(repo.value(), snap.tips, token);
          if (!nodes) throw rpc::HandlerError{{nodes.error()}};

          auto built = std::make_shared<cache::GraphPlan>();
          built->commits = buildOrder(nodes.value(), token);
          built->stashes = snap.stashes;

          // Stash rows precede the commit they were stashed on (the stash
          // commit's first parent). Stashes whose base is not reachable from
          // any walked tip produce no row.
          for (std::size_t i = 0; i < built->stashes.size(); ++i) {
            const std::string& stashSha = built->stashes[i].sha;
            git_oid oid;
            git_commit* rawCommit = nullptr;
            if (git_oid_fromstr(&oid, stashSha.c_str()) != 0 ||
                git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
              throw rpc::HandlerError{{core::gitError("lookup stash " + stashSha)}};
            }
            core::CommitPtr commit(rawCommit);
            if (git_commit_parentcount(commit.get()) == 0) continue;
            const git_oid* base = git_commit_parent_id(commit.get(), 0);
            if (nodes.value().find(*base) != nodes.value().end()) {
              built->stashesByBase[core::oidToHex(*base)].push_back(i);  // index asc
            }
          }
          plan = built;
          context.graphCache.put(cacheKey, plan);
        }

        // Only page 0 can carry the WIP row, so only page 0 pays for the
        // status scan; later pages would compute it and discard it.
        bool wantWip = false;
        if (includeWip && cursor.pos == 0 && !snap.headSha.empty()) {
          auto dirty = workdirDirty(repo.value());
          if (!dirty) throw rpc::HandlerError{{dirty.error()}};
          wantWip = dirty.value();
        }

        LaneState laneState = std::move(cursor.lanes);
        const std::size_t startPos = cursor.pos;
        std::size_t pos = 0;
        std::optional<std::string> nextCursor;

        auto lookupCommit = [&](const std::string& sha) -> core::CommitPtr {
          git_oid oid;
          git_commit* rawCommit = nullptr;
          if (git_oid_fromstr(&oid, sha.c_str()) != 0 ||
              git_commit_lookup(&rawCommit, repo.value().raw(), &oid) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup commit " + sha)}};
          }
          return core::CommitPtr(rawCommit);
        };

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
            nextCursor = encodeCursor(pos, laneState);
            return false;
          }
          RowLayout layout = layoutRow(laneState, sha, parents);
          rpc::Json row = {{"sha", sha},           {"parents", parents},
                           {"lane", layout.lane},  {"laneEdges", std::move(layout.edges)},
                           {"kind", kind}};
          if (stash) {
            core::CommitPtr commit = lookupCommit(sha);
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
            core::CommitPtr commit = lookupCommit(sha);
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

        // Emission follows the cached order; rows before the cursor cost only
        // the counter, so a later page never touches the object database for
        // them.
        bool more = true;
        if (wantWip) more = emitRow(kWipSha, {snap.headSha}, "wip", nullptr);
        for (const auto& row : plan->commits) {
          if (!more) break;
          token.throwIfCancelled();
          if (includeStashes) {
            const auto it = plan->stashesByBase.find(row.sha);
            if (it != plan->stashesByBase.end()) {
              for (const std::size_t index : it->second) {
                const GraphStash& stash = plan->stashes[index];
                more = emitRow(stash.sha, {row.sha}, "stash", &stash);
                if (!more) break;
              }
              if (!more) break;
            }
          }
          more = emitRow(row.sha, row.parents, "commit", nullptr);
        }

        rpc::Json result = {{"rows", std::move(rows)},
                            {"refsFingerprint", snap.refsFingerprint}};
        if (nextCursor) result["nextCursor"] = *nextCursor;
        return result;
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
