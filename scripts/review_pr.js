const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
// fs is injected by the SuperPlane runner wrapper

const CODEOWNERS_PATH = "codeowners.yml";
const MAIN_BRANCHES = ["main", "master"];
const MAX_DIFF_CHARS = 60000;
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-6";
const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-opus-4-6-v1";
const BEDROCK_INFERENCE_PREFIXES = ["global.", "us.", "eu.", "jp.", "au."];
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

function log(msg) {
  console.log(msg);
}

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

async function githubRequest(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "superplane-pr-risk-review",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error("GitHub API error " + response.status + ": " + (await response.text()));
  }
  return response.json();
}

async function resolveEvent(payload) {
  const manual = nodeData(payload, "Check PR");
  if (manual.pull_number) {
    const repo = normalizeRepo(manual.repository);
    if (!repo) {
      throw new Error("Manual check requires repository (owner/repo) and pull request number.");
    }
    const prNumber = String(manual.pull_number).trim();
    const pr = await githubRequest("https://api.github.com/repos/" + repo + "/pulls/" + prNumber);
    const parts = repo.split("/");
    return {
      action: "manual",
      manual: true,
      pull_request: pr,
      repository: {
        full_name: repo,
        name: parts.length > 1 ? parts[parts.length - 1] : repo,
      },
    };
  }

  for (const name of ["On Pull Request", "On PR Review"]) {
    const data = nodeData(payload, name);
    if (data && Object.keys(data).length) return data;
  }
  return {};
}

function runCmd(args, cwd, check) {
  const mustCheck = check !== false;
  try {
    return execFileSync(args[0], args.slice(1), {
      cwd: cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (mustCheck) {
      throw new Error(
        "command failed: " +
          args.join(" ") +
          "\n" +
          (err.stderr || err.stdout || err.message),
      );
    }
    return err.stdout || "";
  }
}

function cloneUrl(repo) {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (token) return "https://x-access-token:" + token + "@github.com/" + repo + ".git";
  return "https://github.com/" + repo + ".git";
}

function readCodeowners(repoDir, baseBranch) {
  const candidates = [];
  for (const branch of [baseBranch, "main", "master"]) {
    if (branch && candidates.indexOf(branch) === -1) candidates.push(branch);
  }
  for (const ref of candidates) {
    for (const prefix of ["origin/", ""]) {
      const spec = prefix + ref + ":" + CODEOWNERS_PATH;
      const out = runCmd(["git", "show", spec], repoDir, false);
      if (String(out || "").trim()) return [String(out), ref];
    }
  }
  return ["", ""];
}

function extractJsonObject(text) {
  let raw = String(text || "").trim();
  if (!raw) throw new Error("empty model response");
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model response");
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeLlmReview(parsed) {
  let riskScore = parseInt(parsed.risk_score, 10) || 0;
  riskScore = Math.max(0, Math.min(100, riskScore));
  let riskLevel = String(parsed.risk_level || "").toLowerCase();
  if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") {
    riskLevel = riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low";
  }
  const approved = parsed.approved === true || String(parsed.approved).toLowerCase() === "true";
  const summary = String(parsed.summary || "").trim();
  let concerns = parsed.concerns || [];
  if (typeof concerns === "string") concerns = concerns.trim() ? [concerns] : [];
  else if (!Array.isArray(concerns)) concerns = [String(concerns)];
  let reviewers = parsed.recommended_reviewers || [];
  if (typeof reviewers === "string") reviewers = reviewers.trim() ? [reviewers] : [];
  else if (!Array.isArray(reviewers)) reviewers = [String(reviewers)];
  const cleanReviewers = [];
  for (const entry of reviewers) {
    const login = String(entry).trim().replace(/^@/, "").toLowerCase();
    if (login) cleanReviewers.push(login);
  }
  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    approved: approved,
    summary: summary,
    concerns: concerns.map(String).map(function (c) {
      return c.trim();
    }).filter(Boolean),
    recommended_reviewers: cleanReviewers,
  };
}

function reviewJsonSchemaExample() {
  return JSON.stringify(
    {
      risk_score: 0,
      risk_level: "low",
      approved: true,
      summary: "one sentence",
      concerns: ["..."],
      recommended_reviewers: ["github-username"],
    },
    null,
    2,
  );
}

function buildReviewPrompt(
  repo,
  prNumber,
  title,
  author,
  baseBranch,
  headSha,
  changedFilesList,
  codeownersText,
  diffStat,
  diffText,
) {
  return (
    "Review this pull request and respond with ONLY valid JSON (no markdown fences).\n\n" +
    "Repository: " +
    repo +
    "\nPR #" +
    prNumber +
    ": " +
    title +
    "\nAuthor: " +
    author +
    "\nBase branch: " +
    baseBranch +
    "\nHead SHA: " +
    headSha +
    "\n\nChanged files:\n" +
    (changedFilesList || "(none)") +
    "\n\ncodeowners.yml policy (from base branch; empty if missing):\n" +
    (codeownersText || "(none)") +
    "\n\nDiff stat:\n" +
    (diffStat || "(none)") +
    "\n\nDiff:\n" +
    (diffText || "(none)") +
    "\n\nEvaluate security, correctness, blast radius, and compliance with codeowners.yml owner rules when present.\n" +
    "Set approved=false when the PR should not merge yet (critical bugs, security issues, missing tests for risky changes, or clear codeowners policy violations).\n\n" +
    "JSON schema:\n" +
    reviewJsonSchemaExample()
  );
}

function resolveLlmProvider() {
  const explicit = String(process.env.LLM_PROVIDER || "").trim().toLowerCase();
  const aliases = {
    anthropic: "anthropic",
    claude: "anthropic",
    bedrock: "bedrock",
    aws: "bedrock",
    codex: "codex",
    openai: "codex",
  };
  if (explicit) {
    const provider = aliases[explicit];
    if (!provider) {
      throw new Error("Unsupported LLM_PROVIDER " + explicit + "; use anthropic, bedrock, or codex.");
    }
    return provider;
  }
  if (String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim()) return "bedrock";
  if (String(process.env.ANTHROPIC_API_KEY || "").trim()) return "anthropic";
  if (String(process.env.OPENAI_API_KEY || "").trim()) return "codex";
  throw new Error(
    "No LLM provider configured. Set LLM_PROVIDER to anthropic, bedrock, or codex and add matching credentials.",
  );
}

function hasBedrockInferencePrefix(modelId) {
  return BEDROCK_INFERENCE_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function bedrockInferencePrefixFromRegion(region) {
  const explicit = String(process.env.BEDROCK_INFERENCE_PROFILE_PREFIX || "").trim();
  if (explicit) return explicit.endsWith(".") ? explicit : explicit + ".";
  const r = String(region || "").trim().toLowerCase();
  if (r.startsWith("eu-")) return "eu.";
  if (r === "ap-northeast-1") return "jp.";
  if (r.startsWith("ap-southeast-")) return "au.";
  return "us.";
}

function resolveBedrockModelId(modelId, region) {
  const model = String(modelId || "").trim();
  if (!model || hasBedrockInferencePrefix(model)) return model;
  return bedrockInferencePrefixFromRegion(region) + model;
}

function resolveModel(provider) {
  const generic = String(process.env.LLM_MODEL || "").trim();
  if (generic) return generic;
  if (provider === "anthropic") {
    return String(process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim() || DEFAULT_ANTHROPIC_MODEL;
  }
  if (provider === "bedrock") {
    return (
      String(process.env.BEDROCK_MODEL_ID || "").trim() ||
      String(process.env.ANTHROPIC_MODEL || "").trim() ||
      DEFAULT_BEDROCK_MODEL
    );
  }
  return (
    String(process.env.CODEX_MODEL || "").trim() ||
    String(process.env.OPENAI_MODEL || "").trim() ||
    DEFAULT_CODEX_MODEL
  );
}

function parseLlmResponse(text, providerLabel) {
  if (!String(text || "").trim()) {
    throw new Error(providerLabel + " returned an empty response");
  }
  return normalizeLlmReview(extractJsonObject(text));
}

async function callAnthropic(prompt, systemMessage) {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic.");
  const model = resolveModel("anthropic");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      system: systemMessage,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error("Anthropic API error " + response.status + ": " + (await response.text()));
  }
  const payload = await response.json();
  const parts = [];
  for (const block of payload.content || []) {
    if (block && block.text) parts.push(String(block.text));
  }
  return { review: parseLlmResponse(parts.join("\n").trim(), "Anthropic API"), model: model };
}

async function callBedrock(prompt, systemMessage) {
  const region = String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim();
  if (!region) throw new Error("AWS_REGION is required when LLM_PROVIDER=bedrock.");
  const model = resolveBedrockModelId(resolveModel("bedrock"), region);
  const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: region });
  const response = await client.send(
    new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        system: systemMessage,
        messages: [{ role: "user", content: prompt }],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body));
  const parts = [];
  for (const block of payload.content || []) {
    if (block && block.type === "text") parts.push(String(block.text || ""));
  }
  let text = parts.join("\n").trim();
  if (!text && payload.completion) text = String(payload.completion).trim();
  return { review: parseLlmResponse(text, "Amazon Bedrock"), model: model };
}

async function callCodex(prompt, systemMessage) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=codex.");
  const model = resolveModel("codex");
  const baseUrl = String(process.env.OPENAI_BASE_URL || "").trim() || "https://api.openai.com/v1";
  const response = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error("OpenAI API error " + response.status + ": " + (await response.text()));
  }
  const payload = await response.json();
  const choice = (payload.choices || [])[0];
  const text = choice && choice.message ? String(choice.message.content || "").trim() : "";
  return { review: parseLlmResponse(text, "OpenAI Codex"), model: model };
}

async function callLlm(prompt, systemMessage) {
  const provider = resolveLlmProvider();
  if (provider === "anthropic") return Object.assign({ provider: provider }, await callAnthropic(prompt, systemMessage));
  if (provider === "bedrock") return Object.assign({ provider: provider }, await callBedrock(prompt, systemMessage));
  return Object.assign({ provider: provider }, await callCodex(prompt, systemMessage));
}

async function main() {
  const event = await resolveEvent($);
  const pr = event.pull_request || {};
  const repository = event.repository || {};
  const repo = repository.full_name || "";
  const prNumber = pr.number;
  const action = event.action || "";
  const isManual = event.manual === true || action === "manual";

  if (!repo || !prNumber) {
    throw new Error("Missing repository or pull request number in trigger payload.");
  }

  const baseBranch = String((pr.base && pr.base.ref) || "");
  const headSha = String((pr.head && pr.head.sha) || "");
  const author = String((pr.user && pr.user.login) || "");
  const title = String(pr.title || "");

  if (MAIN_BRANCHES.indexOf(baseBranch.toLowerCase()) === -1 && !isManual) {
    return {
      skipped: true,
      repository: repo,
      repository_name: repository.name || repo.split("/").pop(),
      pr_number: String(prNumber),
      title: title,
      author: author,
      head_sha: headSha,
      base_branch: baseBranch,
      manual: false,
      reason: "PR risk review only applies to pull requests targeting main or master.",
    };
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-risk-review-"));
  const repoDir = path.join(workdir, "repo");
  let diffText = "";
  let statText = "";
  let changedFilesList = "";
  let changedFilesCount = 0;
  let codeownersText = "";
  let policyBranch = "";

  try {
    log("Cloning " + repo);
    runCmd(["git", "clone", cloneUrl(repo), repoDir]);
    runCmd(["git", "fetch", "--depth", "100", "origin", baseBranch || "main"], repoDir);
    runCmd(["git", "fetch", "--depth", "100", "origin", headSha], repoDir);
    runCmd(["git", "checkout", "--detach", headSha], repoDir);

    const baseRef = "origin/" + (baseBranch || "main");
    statText = runCmd(["git", "diff", baseRef + "...HEAD", "--stat"], repoDir, false);
    diffText = runCmd(["git", "diff", baseRef + "...HEAD"], repoDir, false);
    if (diffText.length > MAX_DIFF_CHARS) {
      diffText = diffText.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated for review]";
    }

    const namesOut = runCmd(["git", "diff", baseRef + "...HEAD", "--name-only"], repoDir, false);
    const names = String(namesOut || "")
      .split("\n")
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean);
    changedFilesCount = names.length;
    changedFilesList = names.slice(0, 200).join("\n");
    if (names.length > 200) {
      changedFilesList += "\n... and " + String(names.length - 200) + " more files";
    }

    const codeownersResult = readCodeowners(repoDir, baseBranch);
    codeownersText = codeownersResult[0];
    policyBranch = codeownersResult[1];
    log("Checked out " + headSha + " (" + changedFilesCount + " files)");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  const provider = resolveLlmProvider();
  log("Calling LLM via " + provider);
  const prompt = buildReviewPrompt(
    repo,
    prNumber,
    title,
    author,
    baseBranch,
    headSha,
    changedFilesList,
    codeownersText,
    statText,
    diffText,
  );
  const systemMessage =
    "You are a senior staff engineer performing pull request risk review. " +
    "Be conservative on approval for high-risk changes. Output JSON only.";
  const llmResult = await callLlm(prompt, systemMessage);
  const llmReview = llmResult.review;
  log(
    "LLM review (" +
      llmResult.provider +
      "/" +
      llmResult.model +
      "): risk=" +
      llmReview.risk_score +
      " approved=" +
      llmReview.approved,
  );

  return {
    skipped: false,
    repository: repo,
    repository_name: repository.name || repo.split("/").pop(),
    pr_number: String(prNumber),
    title: title,
    author: author,
    head_sha: headSha,
    base_branch: baseBranch,
    manual: isManual,
    changed_files: changedFilesCount,
    changed_files_list: changedFilesList,
    codeowners_text: codeownersText,
    policy_branch: policyBranch,
    has_codeowners: Boolean(String(codeownersText).trim()),
    llm_provider: llmResult.provider,
    llm_model: llmResult.model,
    llm_review: llmReview,
  };
}
