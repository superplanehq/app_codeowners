const COMMENT_MARKER = "<!-- superplane-pr-risk-review -->";
const MAIN_BRANCHES = ["main", "master"];

function nodeData(payload, name) {
  const entry = payload[name] || {};
  const data = entry.data || {};
  return data && typeof data === "object" ? data : {};
}

function normalizeRepo(value) {
  let repo = String(value || "").trim();
  for (const prefix of ["https://github.com/", "http://github.com/"]) {
    if (repo.toLowerCase().startsWith(prefix)) repo = repo.slice(prefix.length);
  }
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  return repo.replace(/^\/+|\/+$/g, "");
}

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
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

function resolvePrContext(payload) {
  const manual = nodeData(payload, "Check PR");
  if (manual.pull_number) {
    const repo = normalizeRepo(manual.repository);
    return {
      manual: true,
      action: String(manual.action || "manual"),
      repository: repo,
      repository_name: repo.split("/").pop() || repo,
      pr_number: String(manual.pull_number).trim(),
      title: "",
      author: "",
      head_sha: "",
      base_branch: "",
      draft: false,
    };
  }

  const data = nodeData(payload, "On Pull Request");
  if (data && Object.keys(data).length) {
    const pr = data.pull_request || {};
    const repo = data.repository || {};
    const fullName = normalizeRepo(repo.full_name || repo.name || "");
    return {
      manual: false,
      action: String(data.action || ""),
      repository: fullName,
      repository_name: String(repo.name || fullName.split("/").pop() || ""),
      pr_number: String(pr.number || ""),
      title: String(pr.title || ""),
      author: String((pr.user && pr.user.login) || ""),
      head_sha: String((pr.head && pr.head.sha) || ""),
      base_branch: String((pr.base && pr.base.ref) || ""),
      draft: pr.draft === true,
    };
  }

  return {
    manual: false,
    action: "",
    repository: "",
    repository_name: "",
    pr_number: "",
    title: "",
    author: "",
    head_sha: "",
    base_branch: "",
    draft: false,
  };
}

function buildSkippedResult(ctx, reason) {
  const repository = ctx.repository;
  const prNumber = ctx.pr_number;
  return {
    skipped: true,
    repository: repository,
    repository_name: ctx.repository_name || repository.split("/").pop() || repository,
    pr_number: String(prNumber),
    title: ctx.title,
    author: ctx.author,
    head_sha: ctx.head_sha,
    base_branch: ctx.base_branch,
    manual: ctx.manual,
    reviewers_to_request: [],
    risk_score: 0,
    risk_level: "low",
    recommended_reviewers: "",
    llm_summary: "",
    comment_body: "",
    pr_url: repository && prNumber ? "https://github.com/" + repository + "/pull/" + prNumber : "",
    discord_message: "",
    reason: truncateStatusReason(reason),
    status_description: truncateStatusReason(reason),
  };
}

function parseReviewerDetails(parsed) {
  if (!Array.isArray(parsed.reviewers)) return [];
  return parsed.reviewers
    .map(function (entry) {
      if (!entry || typeof entry !== "object") return null;
      const person = normalizeLogin(entry.person);
      if (!person) return null;
      return {
        person: person,
        required: entry.required === true || String(entry.required).toLowerCase() === "true",
        reason: String(entry.reason || "").trim(),
      };
    })
    .filter(Boolean);
}

function mergeRecommendedReviewers(parsed) {
  const merged = [];
  const seen = {};
  const add = function (login) {
    const normalized = normalizeLogin(login);
    if (!normalized || seen[normalized]) return;
    seen[normalized] = true;
    merged.push(normalized);
  };

  for (const login of asStringArray(parsed.recommended_reviewers)) add(login);
  for (const reviewer of parseReviewerDetails(parsed)) add(reviewer.person);
  return merged;
}

function normalizeConcerns(concerns) {
  return asStringArray(concerns)
    .map(function (concern) {
      return String(concern).replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .slice(0, 8);
}

function riskLevelFromScore(score) {
  if (score <= 20) return "very low";
  if (score <= 40) return "low";
  if (score <= 60) return "medium";
  if (score <= 80) return "high";
  return "critical";
}

function maxReviewersForRisk(score) {
  if (score <= 20) return 1;
  if (score <= 40) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 10;
}

function parseLlmReview(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      risk_score: 50,
      risk_level: "medium",
      summary: "Claude returned an empty review.",
      concerns: [],
      recommended_reviewers: [],
      reviewer_details: [],
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
    const riskLevel = riskLevelFromScore(riskScore);
    return {
      risk_score: riskScore,
      risk_level: riskLevel,
      summary: String(parsed.summary || "").trim(),
      concerns: normalizeConcerns(parsed.concerns),
      recommended_reviewers: mergeRecommendedReviewers(parsed),
      reviewer_details: parseReviewerDetails(parsed),
      title: String(parsed.title || "").trim(),
      author: normalizeLogin(parsed.author),
      repository: normalizeRepo(parsed.repository),
      pr_number: String(parsed.pr_number || parsed.pull_number || "").trim(),
    };
  } catch (error) {
    return {
      risk_score: 50,
      risk_level: "medium",
      summary: "Could not parse Claude review JSON.",
      concerns: [raw.slice(0, 500)],
      recommended_reviewers: [],
      reviewer_details: [],
    };
  }
}

function markCommentBody(body) {
  const text = String(body || "");
  if (!text) return "";
  if (text.indexOf(COMMENT_MARKER) === 0) return text;
  return COMMENT_MARKER + "\n" + text;
}

function mergeReviewers(expertReviewers, author, maxReviewers) {
  const authorNorm = normalizeLogin(author);
  const merged = [];
  const seen = {};
  for (const login of expertReviewers || []) {
    const normalized = normalizeLogin(login);
    if (!normalized || normalized === authorNorm || seen[normalized]) continue;
    seen[normalized] = true;
    merged.push(normalized);
    if (merged.length >= maxReviewers) break;
  }
  return merged;
}

function truncateStatusReason(text) {
  const value = String(text || "").trim();
  if (value.length <= 140) return value;
  return value.slice(0, 137) + "...";
}

function parseNodeTimestamp(payload, name) {
  const entry = payload[name] || {};
  if (!entry.timestamp) return null;
  const ms = new Date(entry.timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function evaluationSeconds(payload) {
  const end = parseNodeTimestamp(payload, "Assess PR Risk");
  const start =
    parseNodeTimestamp(payload, "Should assess?") ||
    parseNodeTimestamp(payload, "Check PR");
  if (!end || !start || end < start) return null;
  return Math.max(1, Math.round((end - start) / 1000));
}

function riskLevelLabel(riskLevel) {
  const level = String(riskLevel || "")
    .trim()
    .toLowerCase();
  if (!level) return "Unknown Risk";
  return (
    level.replace(/\b\w/g, function (char) {
      return char.toUpperCase();
    }) + " Risk"
  );
}

function buildStatusDescription(seconds, riskScore, riskLevel) {
  const label = riskLevelLabel(riskLevel);
  if (seconds == null) {
    return truncateStatusReason(riskScore + "/100 (" + label + ")");
  }
  const unit = seconds === 1 ? "second" : "seconds";
  return truncateStatusReason(
    "Evaluated in " + seconds + " " + unit + ". " + riskScore + "/100 (" + label + ")"
  );
}

function buildDiscordMessage(title, prUrl, author, riskScore, riskLevel, prNumber) {
  const label =
    String(title || "")
      .trim()
      .replace(/[\[\]]/g, "") || "PR #" + prNumber;
  return (
    "[" +
    label +
    "](<" +
    prUrl +
    ">) - " +
    String(author || "unknown") +
    " - Risk " +
    riskScore +
    "/100 (" +
    riskLevel +
    ")"
  );
}

function buildCommentBody(llm) {
  const lines = [];
  lines.push("**Risk:** " + llm.risk_score + "/100 (" + llm.risk_level + ")");
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
  if (llm.recommended_reviewers && llm.recommended_reviewers.length) {
    lines.push("**Recommended reviewers:** " + llm.recommended_reviewers.join(", "));
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function main() {
  const ctx = resolvePrContext($);

  if (!ctx.manual && ctx.draft) {
    return buildSkippedResult(ctx, "Skipped: pull request is a draft.");
  }

  if (!ctx.manual && ctx.base_branch && MAIN_BRANCHES.indexOf(ctx.base_branch) === -1) {
    return buildSkippedResult(ctx, "Skipped: base branch is not main or master.");
  }

  const agent = nodeData($, "Assess PR Risk");
  const lastMessage = String(agent.lastMessage || "").trim();
  if (!lastMessage) {
    throw new Error("Assess PR Risk returned no message.");
  }
  const llmParsed = parseLlmReview(lastMessage);

  const repository = llmParsed.repository || ctx.repository;
  const prNumber = llmParsed.pr_number || ctx.pr_number;
  const title = llmParsed.title || ctx.title;
  const author = llmParsed.author || ctx.author;
  const headSha = ctx.head_sha;
  const baseBranch = ctx.base_branch;

  if (!repository || !prNumber) {
    throw new Error("Missing repository or pull request number from trigger or Claude review JSON.");
  }

  const llm = {
    risk_score: llmParsed.risk_score,
    risk_level: llmParsed.risk_level,
    summary: llmParsed.summary,
    concerns: llmParsed.concerns,
    recommended_reviewers: llmParsed.recommended_reviewers,
  };

  const reviewersToRequest = mergeReviewers(
    llm.recommended_reviewers,
    author,
    maxReviewersForRisk(llm.risk_score)
  );
  const statusDescription = buildStatusDescription(
    evaluationSeconds($),
    llm.risk_score,
    llm.risk_level
  );
  const commentBody = markCommentBody(buildCommentBody(llm));
  const prUrl = "https://github.com/" + repository + "/pull/" + prNumber;
  const discordMessage = commentBody
    ? buildDiscordMessage(title, prUrl, author, llm.risk_score, llm.risk_level, prNumber)
    : "";

  return {
    skipped: false,
    repository: repository,
    repository_name: ctx.repository_name || repository.split("/").pop() || repository,
    pr_number: String(prNumber),
    title: title,
    author: author,
    head_sha: headSha,
    base_branch: baseBranch,
    manual: ctx.manual,
    reviewers_to_request: reviewersToRequest,
    risk_score: llm.risk_score,
    risk_level: llm.risk_level,
    recommended_reviewers: llm.recommended_reviewers.join(", "),
    llm_summary: llm.summary,
    llm_concerns: llm.concerns.join("; "),
    comment_body: commentBody,
    pr_url: prUrl,
    discord_message: discordMessage,
    reason: statusDescription,
    status_description: statusDescription,
  };
}
