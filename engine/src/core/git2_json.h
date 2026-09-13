#pragma once

#include <git2.h>
#include <nlohmann/json.hpp>

namespace gg::core {

/** Author/committer signature as `{name, email, time}`. */
nlohmann::json signatureJson(const git_signature* sig);

}  // namespace gg::core
