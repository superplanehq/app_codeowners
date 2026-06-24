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
    valid: true,
    satisfied: true,
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
    llm_approved: true,
    comment_body: "",
    pr_url: repository && prNumber ? "https://github.com/" + repository + "/pull/" + prNumber : "",
    discord_message: "",
    reason: reason,
  };
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
      title: String(parsed.title || "").trim(),
      author: String(parsed.author || "").trim().replace(/^@/, "").toLowerCase(),
      repository: normalizeRepo(parsed.repository),
      pr_number: String(parsed.pr_number || parsed.pull_number || "").trim(),
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

function markCommentBody(body) {
  const text = String(body || "");
  if (!text) return "";
  if (text.indexOf(COMMENT_MARKER) === 0) return text;
  return COMMENT_MARKER + "\n" + text;
}

function mergeReviewers(expertReviewers, author, maxReviewers) {
  const authorNorm = String(author || "").toLowerCase();
  const merged = [];
  const seen = {};
  for (const login of expertReviewers || []) {
    const normalized = String(login || "").toLowerCase().replace(/^@/, "");
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

function buildStatusReason(llm, valid, llmApproved, reviewersToRequest) {
  let reason = "Risk: " + llm.risk_score + "/100 (" + llm.risk_level + ").";
  if (!llmApproved) {
    reason = "Review: changes requested. " + reason;
  } else if (valid) {
    reason = "Approved. " + reason;
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
  const label =
    String(title || "")
      .trim()
      .replace(/[\[\]]/g, "") || "PR #" + prNumber;
  return "[" + label + "](<" + prUrl + ">) - " + String(author || "unknown") + " - Risk " + riskScore + "/100";
}

function buildCommentBody(llm, valid, llmApproved) {
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
  if (llm.recommended_reviewers && llm.recommended_reviewers.length) {
    lines.push("**Recommended reviewers:** " + llm.recommended_reviewers.join(", "));
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
    approved: llmParsed.approved === true,
    summary: llmParsed.summary,
    concerns: llmParsed.concerns,
    recommended_reviewers: llmParsed.recommended_reviewers,
  };

  const llmApproved = llm.approved === true;
  const valid = llmApproved;
  const reviewersToRequest = mergeReviewers(llm.recommended_reviewers, author, 10);
  const reason = buildStatusReason(llm, valid, llmApproved, reviewersToRequest);
  const commentBody = markCommentBody(buildCommentBody(llm, valid, llmApproved));
  const prUrl = "https://github.com/" + repository + "/pull/" + prNumber;
  const discordMessage = commentBody ? buildDiscordMessage(title, prUrl, author, llm.risk_score, prNumber) : "";

  return {
    valid: valid,
    satisfied: valid,
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
    llm_approved: llmApproved,
    llm_concerns: llm.concerns.join("; "),
    comment_body: commentBody,
    pr_url: prUrl,
    discord_message: discordMessage,
    reason: reason,
  };
}
