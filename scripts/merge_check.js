const yaml = require("js-yaml");

const CODEOWNERS_CONFIG_PATH = "codeowners.yml";
const DEFAULT_COMPLIANCE_REVIEWERS = [];
const COMMENT_MARKER = "<!-- superplane-pr-risk-review -->";
const LEGACY_COMMENT_MARKERS = ["<!-- superplane-codeowners -->"];
const LEGACY_COMMENT_HEADINGS = ["## PR Risk Review", "## Code Owners — Claude review"];

function nodeResult(payload, name) {
  const entry = payload[name] || {};
  const data = entry.data || {};
  return data.result != null ? data.result : data;
}

function asStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "object") return [value];
  return [String(value)];
}

function asRulesArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern) {
  let source = pattern.trim();
  if (!source) return null;
  if (source.startsWith("/")) source = source.slice(1);
  let regex = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "*" && source[i + 1] === "*") {
      if (source[i + 2] === "/") {
        regex += "(?:.+/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(ch);
    }
  }
  return new RegExp("^" + regex + "(?:/.*)?$");
}

function matchPattern(pattern, filePath) {
  const regex = patternToRegex(pattern);
  if (!regex) return false;
  const normalized = String(filePath || "").replace(/^\/+/, "");
  return regex.test(normalized);
}

function parseGroups(doc) {
  const groups = {};
  const raw = doc.groups || {};
  for (const name of Object.keys(raw)) {
    const value = raw[name];
    let members = [];
    if (Array.isArray(value)) {
      members = value;
    } else if (value && typeof value === "object" && value.members != null) {
      members = asStringArray(value.members);
    } else if (typeof value === "string") {
      members = [value];
    }
    groups[String(name).toLowerCase()] = members
      .map(function (member) {
        return String(member).trim().replace(/^@/, "").toLowerCase();
      })
      .filter(Boolean);
  }
  return groups;
}

function parseComplianceReviewers(doc) {
  const list = asStringArray(
    doc.compliance_reviewers != null ? doc.compliance_reviewers : doc.complianceReviewers,
  );
  return list
    .map(function (value) {
      return String(value).trim().replace(/^@/, "").toLowerCase();
    })
    .filter(Boolean);
}

function parseCodeownersYaml(text) {
  const doc = yaml.load(String(text || "")) || {};
  const groups = parseGroups(doc);
  const rules = [];
  for (const rule of asRulesArray(doc.rules)) {
    if (!rule || typeof rule !== "object") continue;
    const patterns = [];
    if (rule.pattern) patterns.push(String(rule.pattern));
    for (const value of asStringArray(rule.patterns)) patterns.push(String(value));
    for (const value of asStringArray(rule.paths)) patterns.push(String(value));
    const owners = asStringArray(rule.owners)
      .map(function (value) {
        return String(value).trim();
      })
      .filter(function (value) {
        return value.indexOf("@") === 0;
      });
    const selfApproval =
      rule.self_approval === true || String(rule.self_approval || "").toLowerCase() === "true";
    for (const pattern of patterns) {
      if (pattern && owners.length) {
        rules.push({ pattern: pattern, owners: owners, self_approval: selfApproval });
      }
    }
  }
  return { rules: rules, groups: groups, complianceReviewers: parseComplianceReviewers(doc) };
}

function matchingRuleForFile(path, rules) {
  let match = null;
  for (const rule of rules) {
    if (matchPattern(rule.pattern, path)) match = rule;
  }
  return match;
}

function ownerLogins(owner, groups) {
  const value = String(owner || "").trim();
  if (!value || value[0] !== "@") return [];
  const ref = String(value.slice(1)).toLowerCase();
  const members = groups[ref];
  if (Array.isArray(members) && members.length) return members.slice();
  return [ref];
}

function ownerMatches(login, owners, groups) {
  const normalized = String(login || "").toLowerCase();
  if (!normalized) return false;
  for (const owner of owners) {
    const logins = ownerLogins(owner, groups);
    if (logins.indexOf(normalized) !== -1) return true;
  }
  return false;
}

function mergeReviewers(expertReviewers, complianceReviewers, author, approvers, maxReviewers) {
  const authorNorm = String(author || "").toLowerCase();
  const approved = {};
  for (const login of approvers || []) {
    approved[String(login).toLowerCase()] = true;
  }
  const merged = [];
  const seen = {};
  for (const list of [complianceReviewers || [], expertReviewers || []]) {
    for (const login of list) {
      const normalized = String(login || "").toLowerCase().replace(/^@/, "");
      if (!normalized || normalized === authorNorm || approved[normalized] || seen[normalized]) continue;
      seen[normalized] = true;
      merged.push(normalized);
      if (merged.length >= maxReviewers) return merged;
    }
  }
  return merged;
}

function parseLlmReview(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      risk_score: 50,
      risk_level: "medium",
      approved: false,
      summary: "Claude returned an empty review.",
      concerns: [],
      recommended_reviewers: [],
    };
  }
  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1].trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start !== -1 && end !== -1) jsonText = jsonText.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonText);
    const riskScore = Math.max(0, Math.min(100, Number(parsed.risk_score) || 0));
    let riskLevel = String(parsed.risk_level || "").toLowerCase();
    if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") {
      riskLevel = riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low";
    }
    return {
      risk_score: riskScore,
      risk_level: riskLevel,
      approved: parsed.approved === true || String(parsed.approved).toLowerCase() === "true",
      summary: String(parsed.summary || "").trim(),
      concerns: asStringArray(parsed.concerns).map(String),
      recommended_reviewers: asStringArray(parsed.recommended_reviewers)
        .map(function (v) {
          return String(v).trim().replace(/^@/, "").toLowerCase();
        })
        .filter(Boolean),
    };
  } catch (error) {
    return {
      risk_score: 50,
      risk_level: "medium",
      approved: false,
      summary: "Could not parse Claude review JSON.",
      concerns: [raw.slice(0, 500)],
      recommended_reviewers: [],
    };
  }
}

async function githubFetchAll(url) {
  const items = [];
  let nextUrl = url;
  while (nextUrl) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
    }
    const response = await fetch(nextUrl, { headers: headers });
    if (!response.ok) {
      throw new Error("GitHub API error " + response.status + ": " + (await response.text()));
    }
    const page = await response.json();
    if (Array.isArray(page)) items.push.apply(items, page);
    const link = response.headers.get("link") || "";
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }
  return items;
}

async function githubRequest(method, url, body) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  }
  const response = await fetch(url, {
    method: method,
    headers: headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("GitHub API error " + response.status + ": " + (await response.text()));
  }
  if (response.status === 204) return null;
  return response.json();
}

function isReviewComment(body) {
  const text = String(body || "");
  if (text.indexOf(COMMENT_MARKER) !== -1) return true;
  for (const marker of LEGACY_COMMENT_MARKERS) {
    if (text.indexOf(marker) !== -1) return true;
  }
  for (const heading of LEGACY_COMMENT_HEADINGS) {
    if (text.indexOf(heading) === 0) return true;
  }
  return false;
}

async function findExistingReviewComment(repo, prNumber) {
  const comments = await githubFetchAll(
    "https://api.github.com/repos/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
  );
  let found = null;
  for (const comment of comments) {
    if (isReviewComment(comment.body)) found = comment;
  }
  return found;
}

async function upsertReviewComment(repo, prNumber, body) {
  const markedBody =
    String(body || "").indexOf(COMMENT_MARKER) === 0 ? String(body || "") : COMMENT_MARKER + "\n" + String(body || "");
  const existing = await findExistingReviewComment(repo, prNumber);
  if (existing) {
    const updated = await githubRequest(
      "PATCH",
      "https://api.github.com/repos/" + repo + "/issues/comments/" + existing.id,
      { body: markedBody },
    );
    return {
      comment_id: String(updated.id),
      comment_url: updated.html_url || "",
      comment_updated: true,
      comment_posted: true,
    };
  }
  const created = await githubRequest(
    "POST",
    "https://api.github.com/repos/" + repo + "/issues/" + prNumber + "/comments",
    { body: markedBody },
  );
  return {
    comment_id: String(created.id),
    comment_url: created.html_url || "",
    comment_updated: false,
    comment_posted: true,
  };
}

function latestApprovals(reviews) {
  const byUser = {};
  for (const review of reviews || []) {
    const login = review && review.user && review.user.login;
    if (!login) continue;
    const submitted = new Date(review.submitted_at || 0).getTime();
    const existing = byUser[login];
    if (!existing || submitted >= existing.submitted) {
      byUser[login] = { login: login, state: review.state, submitted: submitted };
    }
  }
  return Object.keys(byUser)
    .map(function (login) {
      return byUser[login];
    })
    .filter(function (entry) {
      return entry.state === "APPROVED";
    })
    .map(function (entry) {
      return entry.login;
    });
}

function truncateStatusReason(text) {
  const value = String(text || "").trim();
  if (value.length <= 140) return value;
  return value.slice(0, 137) + "...";
}

function buildStatusReason(llm, valid, llmApproved, hasOwnerPolicy, ownersSatisfied, pendingFiles, reviewersToRequest) {
  let reason = "Risk: " + llm.risk_score + "/100 (" + llm.risk_level + ").";
  if (!llmApproved) {
    reason = "Review: changes requested. " + reason;
  } else if (valid) {
    reason = "Approved. " + reason;
  }
  if (hasOwnerPolicy && !ownersSatisfied) {
    reason = "Owners pending (" + pendingFiles.length + "). " + reason;
  }
  if (valid && reviewersToRequest.length) {
    reason +=
      " Requested " +
      reviewersToRequest.length +
      " reviewer" +
      (reviewersToRequest.length === 1 ? "" : "s") +
      ".";
  }
  return truncateStatusReason(reason);
}

function buildDiscordMessage(title, prUrl, author, riskScore, prNumber) {
  const label = String(title || "")
    .trim()
    .replace(/[\[\]]/g, "")
    || "PR #" + prNumber;
  return "[" + label + "](" + prUrl + ") - " + String(author || "unknown") + " - Risk: " + riskScore + "/100";
}

function buildCommentBody(
  llm,
  valid,
  llmApproved,
  hasOwnerPolicy,
  ownersSatisfied,
  pendingFiles,
  pendingOwners,
  approvers,
) {
  const lines = ["## PR Risk Review", ""];
  lines.push("**Risk:** " + llm.risk_score + "/100 (" + llm.risk_level + ")");
  lines.push("**Review approved:** " + (llmApproved ? "Yes" : "No"));
  lines.push("**Check passed:** " + (valid ? "Yes" : "No"));
  lines.push("");
  if (llm.summary) {
    lines.push("### Summary");
    lines.push(llm.summary);
    lines.push("");
  }
  if (llm.concerns && llm.concerns.length) {
    lines.push("### Concerns");
    for (const concern of llm.concerns) {
      lines.push("- " + concern);
    }
    lines.push("");
  }
  if (hasOwnerPolicy) {
    lines.push("### Code owners");
    if (ownersSatisfied) {
      lines.push("All covered files have owner approval.");
      if (approvers.length) {
        lines.push("Approvers: " + approvers.join(", "));
      }
    } else {
      lines.push(
        "Waiting for owner approval on " +
          pendingFiles.length +
          " file(s)." +
          (pendingOwners.length ? " Pending: " + pendingOwners.join(", ") : ""),
      );
    }
    lines.push("");
  }
  if (llm.recommended_reviewers && llm.recommended_reviewers.length) {
    lines.push("**Recommended reviewers:** " + llm.recommended_reviewers.join(", "));
  }
  return lines.join("\n").trim();
}

async function main() {
  const review = nodeResult($, "Review PR");

  if (review.skipped) {
    return {
      valid: true,
      satisfied: true,
      skipped: true,
      repository: review.repository,
      repository_name: review.repository_name,
      pr_number: review.pr_number,
      title: review.title || "",
      author: review.author || "",
      head_sha: review.head_sha || "",
      base_branch: review.base_branch || "",
      policy_branch: "",
      codeowners_path: "",
      has_owner_policy: false,
      manual: review.manual === true,
      changed_files: 0,
      covered_files: 0,
      pending_files: 0,
      pending_owners: "",
      approvers: "",
      reviewers_to_request: [],
      risk_score: 0,
      risk_level: "low",
      recommended_reviewers: "",
      compliance_reviewers: "",
      llm_summary: "",
      llm_approved: true,
      owners_satisfied: true,
      comment_body: "",
      comment_id: "",
      comment_url: "",
      comment_updated: false,
      comment_posted: false,
      pr_url: "",
      discord_message: "",
      notify_discord: false,
      reason: review.reason || "Skipped.",
      file_results: [],
      pending: [],
    };
  }

  const llmRaw = review.llm_review || {};
  const llm = {
    risk_score: Number(llmRaw.risk_score) || 0,
    risk_level: String(llmRaw.risk_level || "low"),
    approved: llmRaw.approved === true,
    summary: String(llmRaw.summary || ""),
    concerns: Array.isArray(llmRaw.concerns) ? llmRaw.concerns.map(String) : [],
    recommended_reviewers: Array.isArray(llmRaw.recommended_reviewers)
      ? llmRaw.recommended_reviewers.map(function (v) {
          return String(v).trim().replace(/^@/, "").toLowerCase();
        }).filter(Boolean)
      : [],
  };

  const repo = review.repository;
  const prNumber = review.pr_number;
  const author = review.author || "";
  const title = review.title || "";
  const codeownersText = review.codeowners_text || "";
  const parsed = codeownersText.trim() ? parseCodeownersYaml(codeownersText) : { rules: [], groups: {}, complianceReviewers: [] };
  const rules = parsed.rules;
  const groups = parsed.groups;
  const complianceReviewers = parsed.complianceReviewers.length
    ? parsed.complianceReviewers
    : DEFAULT_COMPLIANCE_REVIEWERS.slice();
  const hasOwnerPolicy = rules.length > 0;

  const changedPaths = String(review.changed_files_list || "")
    .split("\n")
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line && line.indexOf("... and ") !== 0;
    });

  const reviews = await githubFetchAll(
    "https://api.github.com/repos/" + repo + "/pulls/" + prNumber + "/reviews?per_page=100",
  );
  const approvers = latestApprovals(reviews);

  const fileResults = [];
  for (const path of changedPaths) {
    const matched = matchingRuleForFile(path, rules);
    if (!matched || !matched.owners.length) {
      fileResults.push({
        path: path,
        owners: [],
        self_approval: false,
        approved_by: [],
        satisfied: true,
      });
      continue;
    }
    const owners = matched.owners;
    const selfApproval = matched.self_approval === true;
    const approvedBy = [];
    for (const login of approvers) {
      if (ownerMatches(login, owners, groups)) approvedBy.push(login);
    }
    let satisfied = approvedBy.length > 0;
    let autoApproved = false;
    if (!satisfied && selfApproval && author) {
      if (ownerMatches(author, owners, groups)) {
        satisfied = true;
        autoApproved = true;
        approvedBy.push(author);
      }
    }
    fileResults.push({
      path: path,
      owners: owners,
      self_approval: selfApproval,
      approved_by: approvedBy,
      auto_approved: autoApproved,
      satisfied: satisfied,
    });
  }

  const coveredFiles = fileResults.filter(function (entry) {
    return entry.owners.length > 0;
  });
  const pendingFiles = fileResults.filter(function (entry) {
    return entry.owners.length > 0 && !entry.satisfied;
  });
  const ownersSatisfied = pendingFiles.length === 0;
  const llmApproved = llm.approved === true;
  const valid = ownersSatisfied && llmApproved;

  const pendingOwners = [];
  const seenOwners = {};
  for (const entry of pendingFiles) {
    for (const owner of entry.owners) {
      if (!seenOwners[owner]) {
        seenOwners[owner] = true;
        pendingOwners.push(owner);
      }
    }
  }

  const expertReviewers = llm.recommended_reviewers;
  const reviewersToRequest = mergeReviewers(expertReviewers, complianceReviewers, author, approvers, 10);

  const reason = buildStatusReason(
    llm,
    valid,
    llmApproved,
    hasOwnerPolicy,
    ownersSatisfied,
    pendingFiles,
    reviewersToRequest,
  );
  const commentBody = buildCommentBody(
    llm,
    valid,
    llmApproved,
    hasOwnerPolicy,
    ownersSatisfied,
    pendingFiles,
    pendingOwners,
    approvers,
  );

  let commentMeta = {
    comment_id: "",
    comment_url: "",
    comment_updated: false,
    comment_posted: false,
  };
  if (commentBody) {
    commentMeta = await upsertReviewComment(repo, prNumber, commentBody);
  }

  const prUrl = "https://github.com/" + repo + "/pull/" + prNumber;
  const notifyDiscord = commentMeta.comment_posted && !commentMeta.comment_updated;
  const discordMessage = notifyDiscord
    ? buildDiscordMessage(title, prUrl, author, llm.risk_score, prNumber)
    : "";

  return {
    valid: valid,
    satisfied: valid,
    repository: repo,
    repository_name: review.repository_name,
    pr_number: String(prNumber),
    title: review.title || "",
    author: author,
    head_sha: review.head_sha || "",
    base_branch: review.base_branch || "",
    policy_branch: review.policy_branch || "",
    codeowners_path: codeownersText.trim() ? CODEOWNERS_CONFIG_PATH : "",
    has_owner_policy: hasOwnerPolicy,
    manual: review.manual === true,
    changed_files: review.changed_files || changedPaths.length,
    covered_files: coveredFiles.length,
    pending_files: pendingFiles.length,
    pending_owners: pendingOwners.join(", "),
    approvers: approvers.join(", "),
    reviewers_to_request: reviewersToRequest,
    risk_score: llm.risk_score,
    risk_level: llm.risk_level,
    recommended_reviewers: expertReviewers.join(", "),
    compliance_reviewers: complianceReviewers.join(", "),
    llm_summary: llm.summary,
    llm_approved: llmApproved,
    owners_satisfied: ownersSatisfied,
    llm_concerns: llm.concerns.join("; "),
    comment_body: commentBody,
    comment_id: commentMeta.comment_id,
    comment_url: commentMeta.comment_url,
    comment_updated: commentMeta.comment_updated,
    comment_posted: commentMeta.comment_posted,
    pr_url: prUrl,
    discord_message: discordMessage,
    notify_discord: notifyDiscord,
    reason: reason,
    file_results: fileResults,
    pending: pendingFiles,
  };
}
