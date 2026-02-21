#!/usr/bin/env node
"use strict";

// src/infrastructure/fs-repository.ts
var import_promises = require("fs/promises");
var import_path = require("path");
var import_fs = require("fs");

// src/domain/types.ts
var TASK_TYPES = ["frontend", "backend", "general"];
var VALID_TASK_TYPES = new Set(TASK_TYPES);
var DEFAULT_CONFIG = {
  autoCommit: true,
  verifyTimeout: 3e5,
  summaryCompressThreshold: 50,
  maxRetries: 3,
  lockTimeout: 3e4
};

// src/infrastructure/git.ts
var import_node_child_process = require("child_process");
var import_node_fs = require("fs");
function getSubmodules() {
  if (!(0, import_node_fs.existsSync)(".gitmodules")) return [];
  const out = (0, import_node_child_process.execSync)('git submodule --quiet foreach "echo $sm_path"', { stdio: "pipe", encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}
function groupBySubmodule(files, submodules) {
  const sorted = [...submodules].sort((a, b) => b.length - a.length);
  const groups = /* @__PURE__ */ new Map();
  for (const f of files) {
    const norm = f.replace(/\\/g, "/");
    const sub = sorted.find((s) => norm.startsWith(s + "/"));
    const key = sub ?? "";
    const rel = sub ? norm.slice(sub.length + 1) : norm;
    groups.set(key, [...groups.get(key) ?? [], rel]);
  }
  return groups;
}
function commitIn(cwd, files, msg) {
  const opts = { stdio: "pipe", cwd, encoding: "utf-8" };
  try {
    if (files) {
      for (const f of files) (0, import_node_child_process.execFileSync)("git", ["add", f], opts);
    } else {
      (0, import_node_child_process.execFileSync)("git", ["add", "-A"], opts);
    }
    const status = (0, import_node_child_process.execSync)("git diff --cached --quiet || echo HAS_CHANGES", opts).trim();
    if (status === "HAS_CHANGES") {
      (0, import_node_child_process.execFileSync)("git", ["commit", "-F", "-"], { ...opts, input: msg });
    }
    return null;
  } catch (e) {
    return `${cwd}: ${e.stderr?.toString?.() || e.message}`;
  }
}
function gitDiscardInterruptedChanges() {
  try {
    const status = (0, import_node_child_process.execSync)("git status --porcelain", { stdio: "pipe", encoding: "utf-8" }).trim();
    if (status) {
      (0, import_node_child_process.execSync)('git stash push -m "flowpilot-resume: auto-stashed on interrupt recovery"', { stdio: "pipe" });
    }
  } catch (e) {
    process.stderr.write(`[flowpilot] git stash \u8B66\u544A: ${e.message}
`);
  }
}
function pruneFlowpilotStash(maxKeep = 5) {
  try {
    const list = (0, import_node_child_process.execSync)("git stash list", { stdio: "pipe", encoding: "utf-8" }).trim();
    if (!list) return;
    const entries = list.split("\n");
    const fpEntries = [];
    entries.forEach((line, i) => {
      if (line.includes("flowpilot-resume:")) {
        fpEntries.push(i);
      }
    });
    const toDrop = fpEntries.slice(maxKeep);
    for (let i = toDrop.length - 1; i >= 0; i--) {
      try {
        (0, import_node_child_process.execSync)(`git stash drop stash@{${toDrop[i]}}`, { stdio: "pipe" });
      } catch {
      }
    }
  } catch {
  }
}
function autoCommit(taskId, title, summary, files) {
  const msg = `task-${taskId}: ${title}

${summary}`;
  const errors = [];
  const submodules = getSubmodules();
  if (!submodules.length) {
    const err = commitIn(process.cwd(), files?.length ? files : null, msg);
    return err;
  }
  if (files?.length) {
    const groups = groupBySubmodule(files, submodules);
    for (const [sub, subFiles] of groups) {
      if (sub) {
        const err = commitIn(sub, subFiles, msg);
        if (err) errors.push(err);
      }
    }
    try {
      const parentFiles = groups.get("") ?? [];
      const touchedSubs = [...groups.keys()].filter((k) => k !== "");
      for (const s of touchedSubs) (0, import_node_child_process.execFileSync)("git", ["add", s], { stdio: "pipe" });
      for (const f of parentFiles) (0, import_node_child_process.execFileSync)("git", ["add", f], { stdio: "pipe" });
      const status = (0, import_node_child_process.execSync)("git diff --cached --quiet || echo HAS_CHANGES", { stdio: "pipe", encoding: "utf-8" }).trim();
      if (status === "HAS_CHANGES") {
        (0, import_node_child_process.execFileSync)("git", ["commit", "-F", "-"], { stdio: "pipe", input: msg });
      }
    } catch (e) {
      errors.push(`parent: ${e.stderr?.toString?.() || e.message}`);
    }
  } else {
    for (const sub of submodules) {
      const err2 = commitIn(sub, null, msg);
      if (err2) errors.push(err2);
    }
    const err = commitIn(process.cwd(), null, msg);
    if (err) errors.push(err);
  }
  return errors.length ? errors.join("\n") : null;
}

// src/infrastructure/verify.ts
var import_node_child_process2 = require("child_process");
var import_node_fs2 = require("fs");
var import_node_path = require("path");
function runVerify(cwd, customCommands, timeout = 3e5) {
  const cmds = customCommands?.length ? customCommands : detectCommands(cwd);
  if (!cmds.length) return { passed: true, scripts: [] };
  for (const cmd of cmds) {
    try {
      (0, import_node_child_process2.execSync)(cmd, { cwd, stdio: "pipe", timeout });
    } catch (e) {
      const stderr = e.stderr?.length ? e.stderr.toString() : "";
      const stdout = e.stdout?.length ? e.stdout.toString() : "";
      const out = stderr || stdout || "";
      if (out.includes("No test files found")) continue;
      if (out.includes("no test files")) continue;
      return { passed: false, scripts: cmds, error: `${cmd} \u5931\u8D25:
${out.slice(0, 500)}` };
    }
  }
  return { passed: true, scripts: cmds };
}
function detectCommands(cwd) {
  const has = (f) => (0, import_node_fs2.existsSync)((0, import_node_path.join)(cwd, f));
  if (has("package.json")) {
    try {
      const s = JSON.parse((0, import_node_fs2.readFileSync)((0, import_node_path.join)(cwd, "package.json"), "utf-8")).scripts || {};
      return ["build", "test", "lint"].filter((k) => k in s).map((k) => `npm run ${k}`);
    } catch {
    }
  }
  if (has("Cargo.toml")) return ["cargo build", "cargo test"];
  if (has("go.mod")) return ["go build ./...", "go test ./..."];
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const cmds = [];
    if (has("pyproject.toml")) {
      try {
        const txt = (0, import_node_fs2.readFileSync)((0, import_node_path.join)(cwd, "pyproject.toml"), "utf-8");
        if (txt.includes("ruff")) cmds.push("ruff check .");
        if (txt.includes("mypy")) cmds.push("mypy .");
      } catch {
      }
    }
    cmds.push("python -m pytest --tb=short -q");
    return cmds;
  }
  if (has("pom.xml")) return ["mvn compile -q", "mvn test -q"];
  if (has("build.gradle") || has("build.gradle.kts")) return ["gradle build"];
  if (has("CMakeLists.txt")) return ["cmake --build build", "ctest --test-dir build"];
  if (has("Makefile")) {
    try {
      const mk = (0, import_node_fs2.readFileSync)((0, import_node_path.join)(cwd, "Makefile"), "utf-8");
      const targets = [];
      if (/^build\s*:/m.test(mk)) targets.push("make build");
      if (/^test\s*:/m.test(mk)) targets.push("make test");
      if (/^lint\s*:/m.test(mk)) targets.push("make lint");
      if (targets.length) return targets;
    } catch {
    }
  }
  const dirEntries = (() => {
    try {
      return (0, import_node_fs2.readdirSync)(cwd);
    } catch {
      return [];
    }
  })();
  if (dirEntries.some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) {
    return ["dotnet build", "dotnet test"];
  }
  if (has("Gemfile")) {
    const cmds = [];
    if (has(".rubocop.yml")) cmds.push("rubocop");
    cmds.push("bundle exec rake test");
    return cmds;
  }
  if (has("composer.json")) {
    const cmds = [];
    try {
      const pkg = JSON.parse((0, import_node_fs2.readFileSync)((0, import_node_path.join)(cwd, "composer.json"), "utf-8"));
      const scripts = pkg.scripts || {};
      if ("test" in scripts) cmds.push("composer test");
      if ("lint" in scripts) cmds.push("composer lint");
    } catch {
    }
    if (!cmds.length) cmds.push("vendor/bin/phpunit");
    return cmds;
  }
  if (has("mix.exs")) return ["mix compile", "mix test"];
  if (has("pubspec.yaml")) {
    if (has("lib") && (0, import_node_fs2.existsSync)((0, import_node_path.join)(cwd, "test"))) {
      return has("android") || has("ios") ? ["flutter analyze", "flutter test"] : ["dart analyze", "dart test"];
    }
  }
  if (has("Package.swift")) return ["swift build", "swift test"];
  return [];
}

// src/infrastructure/fs-repository.ts
function generateClaudeMdBlock() {
  return `<!-- flowpilot:start -->
## FlowPilot Workflow Protocol (MANDATORY \u2014 any violation is a protocol failure)

**You are the dispatcher. These rules have the HIGHEST priority and are ALWAYS active.**

### On Session Start
Run \`node flow.js resume\`:
- If unfinished workflow \u2192 enter **Execution Loop** (unless user is asking an unrelated question \u2014 handle it first via **Ad-hoc Dispatch**, then remind user the workflow is paused)
- If no workflow \u2192 **judge the request**: reply directly for pure chitchat, use **Ad-hoc Dispatch** for one-off tasks, or enter **Requirement Decomposition** for multi-step development work. When in doubt, prefer the heavier path.

### Ad-hoc Dispatch (one-off tasks, no workflow init)
Dispatch sub-agent(s) via Task tool. No init/checkpoint/finish needed. Iron Rule #4 does NOT apply (no task ID exists). Main agent MAY use Read/Glob/Grep directly for trivial lookups (e.g. reading a single file) \u2014 Iron Rule #2 is relaxed in Ad-hoc mode only.

### Iron Rules (violating ANY = protocol failure)
1. **NEVER use TaskCreate / TaskUpdate / TaskList** \u2014 use ONLY \`node flow.js xxx\`.
2. **Main agent can ONLY use Bash, Task, and Skill** \u2014 Edit, Write, Read, Glob, Grep, Explore are ALL FORBIDDEN. To read any file (including docs), dispatch a sub-agent.
3. **ALWAYS dispatch via Task tool** \u2014 one Task call per task. N tasks = N Task calls **in a single message** for parallel execution.
4. **Sub-agents MUST run checkpoint with --files before replying** \u2014 \`echo 'summary' | node flow.js checkpoint <id> --files file1 file2\` is the LAST command before reply. MUST list all created/modified files. Skipping = protocol failure.

### Requirement Decomposition
1. Dispatch a sub-agent to read requirement docs and return a summary.
2. Use /superpowers:brainstorming to brainstorm and produce a task list.
3. Pipe into init using this **exact format**:
\`\`\`bash
cat <<'EOF' | node flow.js init
1. [backend] Task title
   Description of what to do
2. [frontend] Another task (deps: 1)
   Description here
3. [general] Third task (deps: 1, 2)
EOF
\`\`\`
Format: \`[type]\` = frontend/backend/general, \`(deps: N)\` = dependency IDs, indented lines = description.

### Execution Loop
1. Run \`node flow.js next --batch\`. **NOTE: this command will REFUSE to return tasks if any previous task is still \`active\`. You must checkpoint or resume first.**
2. The output already contains checkpoint commands per task. For **EVERY** task in batch, dispatch a sub-agent via Task tool. **ALL Task calls in one message.** Copy the ENTIRE task block (including checkpoint commands) into each sub-agent prompt verbatim.
3. **After ALL sub-agents return**: run \`node flow.js status\`.
   - If any task is still \`active\` \u2192 sub-agent failed to checkpoint. Run fallback: \`echo 'summary from sub-agent output' | node flow.js checkpoint <id> --files file1 file2\`
   - **Do NOT call \`node flow.js next\` until zero active tasks remain** (the command will error anyway).
4. Loop back to step 1.
5. When \`next\` returns "\u5168\u90E8\u5B8C\u6210", enter **Finalization**.

### Mid-Workflow Commands
- \`node flow.js skip <id>\` \u2014 skip a stuck/unnecessary task (avoid skipping active tasks with running sub-agents)
- \`node flow.js add <\u63CF\u8FF0> [--type frontend|backend|general]\` \u2014 inject a new task mid-workflow

### Sub-Agent Prompt Template
Each sub-agent prompt MUST contain these sections in order:
1. Task block from \`next\` output (title, type, description, checkpoint commands, context)
2. **Pre-analysis (MANDATORY)**: Before writing ANY code, **MUST** invoke /superpowers:brainstorming to perform multi-dimensional analysis (requirements, edge cases, architecture, risks). Skipping = protocol failure.
3. **Skill routing**: type=frontend \u2192 **MUST** invoke /frontend-design, type=backend \u2192 **MUST** invoke /feature-dev, type=general \u2192 execute directly. **For ALL types, you MUST also check available skills and MCP tools; use any that match the task alongside the primary skill.**
4. **Unfamiliar APIs \u2192 MUST query context7 MCP first. Never guess.**

### Sub-Agent Checkpoint (Iron Rule #4 \u2014 most common violation)
Sub-agent's LAST Bash command before replying MUST be:
\`\`\`
echo '\u4E00\u53E5\u8BDD\u6458\u8981' | node flow.js checkpoint <id> --files file1 file2 ...
\`\`\`
- \`--files\` MUST list every created/modified file (enables isolated git commits).
- If task failed: \`echo 'FAILED' | node flow.js checkpoint <id>\`
- If sub-agent replies WITHOUT running checkpoint \u2192 protocol failure. Main agent MUST run fallback checkpoint in step 3.

### Security Rules (sub-agents MUST follow)
- SQL: parameterized queries only. XSS: no unsanitized v-html/innerHTML.
- Auth: secrets from env vars, bcrypt passwords, token expiry.
- Input: validate at entry points. Never log passwords. Never commit .env.

### Finalization (MANDATORY \u2014 skipping = protocol failure)
1. Run \`node flow.js finish\` \u2014 runs verify (build/test/lint). If fail \u2192 dispatch sub-agent to fix \u2192 retry finish.
2. When finish returns "\u9A8C\u8BC1\u901A\u8FC7\uFF0C\u8BF7\u6D3E\u5B50Agent\u6267\u884C code-review" \u2192 dispatch a sub-agent to run /code-review:code-review. Fix issues if any.
3. Run \`node flow.js review\` to mark code-review done.
4. Run \`node flow.js finish\` again \u2014 verify passes + review done \u2192 final commit \u2192 idle.
**Loop: finish(verify) \u2192 review(code-review) \u2192 fix \u2192 finish again. Both gates must pass.**

<!-- flowpilot:end -->`;
}
var FsWorkflowRepository = class {
  root;
  ctxDir;
  base;
  constructor(basePath) {
    this.base = basePath;
    this.root = (0, import_path.join)(basePath, ".workflow");
    this.ctxDir = (0, import_path.join)(this.root, "context");
  }
  projectRoot() {
    return this.base;
  }
  async ensure(dir) {
    await (0, import_promises.mkdir)(dir, { recursive: true });
  }
  /** 文件锁：用 O_EXCL 创建 lockfile + PID 活性检测，防止并发读写 */
  async lock(maxWait = 3e4) {
    await this.ensure(this.root);
    const lockPath = (0, import_path.join)(this.root, ".lock");
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const fd = (0, import_fs.openSync)(lockPath, "wx");
        const info = `${process.pid}
${Date.now()}
`;
        (0, import_fs.writeSync)(fd, info);
        (0, import_fs.closeSync)(fd);
        return;
      } catch {
        try {
          const content = (0, import_fs.readFileSync)(lockPath, "utf-8");
          const [pidStr, tsStr] = content.split("\n");
          const holderPid = parseInt(pidStr, 10);
          const lockAge = Date.now() - parseInt(tsStr, 10);
          if (holderPid && !isNaN(holderPid)) {
            try {
              process.kill(holderPid, 0);
            } catch {
              try {
                (0, import_fs.unlinkSync)(lockPath);
              } catch {
              }
              continue;
            }
          }
          if (lockAge > 6e4) {
            try {
              (0, import_fs.unlinkSync)(lockPath);
            } catch {
            }
            continue;
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("\u65E0\u6CD5\u83B7\u53D6\u6587\u4EF6\u9501\uFF08\u8D85\u65F6\uFF09\uFF0C\u53EF\u80FD\u6709\u53E6\u4E00\u4E2A flow.js \u8FDB\u7A0B\u6B63\u5728\u8FD0\u884C");
  }
  async unlock() {
    try {
      await (0, import_promises.unlink)((0, import_path.join)(this.root, ".lock"));
    } catch {
    }
  }
  // --- progress.md 读写 ---
  async saveProgress(data) {
    await this.ensure(this.root);
    const lines = [
      `# ${data.name}`,
      "",
      `\u72B6\u6001: ${data.status}`,
      "",
      "| ID | \u6807\u9898 | \u7C7B\u578B | \u4F9D\u8D56 | \u72B6\u6001 | \u91CD\u8BD5 | \u6458\u8981 | \u63CF\u8FF0 |",
      "|----|------|------|------|------|------|------|------|"
    ];
    for (const t of data.tasks) {
      const deps = t.deps.length ? t.deps.join(",") : "-";
      const esc = (s) => (s || "-").replace(/\|/g, "\u2223").replace(/\n/g, " ");
      lines.push(`| ${t.id} | ${esc(t.title)} | ${t.type} | ${deps} | ${t.status} | ${t.retries} | ${esc(t.summary)} | ${esc(t.description)} |`);
    }
    const meta = {
      startedAt: data.startedAt,
      activeTaskIds: data.activeTaskIds
    };
    lines.push("");
    lines.push(`<!-- meta: ${JSON.stringify(meta)} -->`);
    const p = (0, import_path.join)(this.root, "progress.md");
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await (0, import_promises.writeFile)(tmp, lines.join("\n") + "\n", "utf-8");
    await (0, import_promises.rename)(tmp, p);
  }
  async loadProgress() {
    try {
      const raw = await (0, import_promises.readFile)((0, import_path.join)(this.root, "progress.md"), "utf-8");
      return this.parseProgress(raw);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new Error(`\u8BFB\u53D6 progress.md \u5931\u8D25: ${e.message}`);
    }
  }
  parseProgress(raw) {
    const validWfStatus = /* @__PURE__ */ new Set(["idle", "running", "finishing", "completed", "aborted"]);
    const validTaskStatus = /* @__PURE__ */ new Set(["pending", "active", "done", "skipped", "failed"]);
    const lines = raw.split("\n");
    const name = (lines[0] ?? "").replace(/^#\s*/, "").trim();
    let status = "idle";
    let activeTaskIds = [];
    let startedAt = 0;
    const tasks = [];
    for (const line of lines) {
      if (line.startsWith("\u72B6\u6001: ")) {
        const s = line.slice(4).trim();
        status = validWfStatus.has(s) ? s : "idle";
      }
      const metaMatch = line.match(/^<!-- meta: ({.*}) -->$/);
      if (metaMatch) {
        try {
          const meta = JSON.parse(metaMatch[1]);
          if (Array.isArray(meta.activeTaskIds)) activeTaskIds = meta.activeTaskIds;
          if (typeof meta.startedAt === "number") startedAt = meta.startedAt;
        } catch {
        }
      }
      const m = line.match(/^\|\s*(\d{3,})\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
      if (m) {
        const depsRaw = m[4].trim();
        tasks.push({
          id: m[1],
          title: m[2],
          type: m[3],
          deps: depsRaw === "-" ? [] : depsRaw.split(",").map((d) => d.trim()),
          status: validTaskStatus.has(m[5]) ? m[5] : "pending",
          retries: parseInt(m[6], 10),
          summary: m[7] === "-" ? "" : m[7],
          description: m[8] === "-" ? "" : m[8],
          failHistory: [],
          timestamps: { created: startedAt || Date.now() }
        });
      }
    }
    return { name, status, activeTaskIds, tasks, startedAt };
  }
  // --- context/ 任务详细产出 ---
  async clearContext() {
    await (0, import_promises.rm)(this.ctxDir, { recursive: true, force: true });
  }
  async clearAll() {
    await (0, import_promises.rm)(this.root, { recursive: true, force: true });
  }
  async saveTaskContext(taskId, content) {
    await this.ensure(this.ctxDir);
    const p = (0, import_path.join)(this.ctxDir, `task-${taskId}.md`);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await (0, import_promises.writeFile)(tmp, content, "utf-8");
    await (0, import_promises.rename)(tmp, p);
  }
  async loadTaskContext(taskId) {
    try {
      return await (0, import_promises.readFile)((0, import_path.join)(this.ctxDir, `task-${taskId}.md`), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new Error(`\u8BFB\u53D6 task-${taskId}.md \u5931\u8D25: ${e.message}`);
    }
  }
  // --- summary.md ---
  async saveSummary(content) {
    await this.ensure(this.ctxDir);
    const p = (0, import_path.join)(this.ctxDir, "summary.md");
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await (0, import_promises.writeFile)(tmp, content, "utf-8");
    await (0, import_promises.rename)(tmp, p);
  }
  async loadSummary() {
    try {
      return await (0, import_promises.readFile)((0, import_path.join)(this.ctxDir, "summary.md"), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") return "";
      throw new Error(`\u8BFB\u53D6 summary.md \u5931\u8D25: ${e.message}`);
    }
  }
  // --- tasks.md ---
  async saveTasks(content) {
    await this.ensure(this.root);
    await (0, import_promises.writeFile)((0, import_path.join)(this.root, "tasks.md"), content, "utf-8");
  }
  async loadTasks() {
    try {
      return await (0, import_promises.readFile)((0, import_path.join)(this.root, "tasks.md"), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new Error(`\u8BFB\u53D6 tasks.md \u5931\u8D25: ${e.message}`);
    }
  }
  async ensureClaudeMd() {
    const base = (0, import_path.join)(this.root, "..");
    const path = (0, import_path.join)(base, "CLAUDE.md");
    const marker = "<!-- flowpilot:start -->";
    const block = generateClaudeMdBlock();
    try {
      const content = await (0, import_promises.readFile)(path, "utf-8");
      if (content.includes(marker)) return false;
      await (0, import_promises.writeFile)(path, content.trimEnd() + "\n\n" + block + "\n", "utf-8");
    } catch {
      await (0, import_promises.writeFile)(path, "# Project\n\n" + block + "\n", "utf-8");
    }
    return true;
  }
  async ensureHooks() {
    const dir = (0, import_path.join)(this.base, ".claude");
    const path = (0, import_path.join)(dir, "settings.json");
    const hook = (m) => ({
      matcher: m,
      hooks: [{ type: "prompt", prompt: "BLOCK this tool call. FlowPilot requires using node flow.js commands instead of native task tools." }]
    });
    const required = {
      PreToolUse: [hook("TaskCreate"), hook("TaskUpdate"), hook("TaskList")]
    };
    let settings = {};
    try {
      const parsed = JSON.parse(await (0, import_promises.readFile)(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !("__proto__" in parsed) && !("constructor" in parsed)) settings = parsed;
    } catch {
    }
    const hooks = settings.hooks ?? {};
    const existing = hooks.PreToolUse;
    if (existing?.some((h) => h.matcher === required.PreToolUse[0].matcher)) return false;
    hooks.PreToolUse = [...existing ?? [], ...required.PreToolUse];
    settings.hooks = hooks;
    await (0, import_promises.mkdir)(dir, { recursive: true });
    await (0, import_promises.writeFile)(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  }
  // --- Git / Verify ---
  commit(taskId, title, summary, files) {
    return autoCommit(taskId, title, summary, files);
  }
  cleanup() {
    gitDiscardInterruptedChanges();
  }
  pruneStash(maxKeep = 5) {
    pruneFlowpilotStash(maxKeep);
  }
  verify(config) {
    return runVerify(this.base, config?.verifyCommands, config?.verifyTimeout);
  }
  // --- 配置 ---
  async saveConfig(config) {
    const p = (0, import_path.join)(this.root, "config.json");
    await (0, import_promises.writeFile)(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
  async loadConfig() {
    try {
      const raw = await (0, import_promises.readFile)((0, import_path.join)(this.root, "config.json"), "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  // --- 执行历史 ---
  async appendHistory(entry) {
    const p = (0, import_path.join)(this.root, "history.jsonl");
    const line = JSON.stringify(entry) + "\n";
    await (0, import_promises.writeFile)(p, line, { flag: "a" });
  }
  async loadHistory() {
    try {
      const raw = await (0, import_promises.readFile)((0, import_path.join)(this.root, "history.jsonl"), "utf-8");
      return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  // --- CLAUDE.md 清理 ---
  async removeClaudeMd() {
    const p = (0, import_path.join)(this.base, "CLAUDE.md");
    try {
      const content = await (0, import_promises.readFile)(p, "utf-8");
      const cleaned = content.replace(
        /\n*<!-- flowpilot:start -->[\s\S]*?<!-- flowpilot:end -->\n*/g,
        "\n"
      );
      const final = cleaned.replace(
        /\n*<!-- flowpilot:watermark -->[\s\S]*?<!-- flowpilot:watermark:end -->\n*/g,
        "\n"
      );
      await (0, import_promises.writeFile)(p, final.trimEnd() + "\n", "utf-8");
    } catch {
    }
  }
  // --- Hooks 清理 ---
  async removeHooks() {
    const p = (0, import_path.join)(this.base, ".claude", "settings.json");
    try {
      const raw = await (0, import_promises.readFile)(p, "utf-8");
      const settings = JSON.parse(raw);
      const pre = settings.hooks?.PreToolUse;
      if (Array.isArray(pre)) {
        settings.hooks.PreToolUse = pre.filter(
          (h) => !h.hooks?.[0]?.prompt?.includes?.("FlowPilot")
        );
        if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
        if (!Object.keys(settings.hooks || {}).length) delete settings.hooks;
      }
      await (0, import_promises.writeFile)(p, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch {
    }
  }
  // --- 心跳（Compact 恢复） ---
  async saveHeartbeat(data) {
    const p = (0, import_path.join)(this.root, "heartbeat.json");
    await (0, import_promises.writeFile)(p, JSON.stringify(data) + "\n", "utf-8");
  }
  async loadHeartbeat() {
    try {
      const raw = await (0, import_promises.readFile)((0, import_path.join)(this.root, "heartbeat.json"), "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      return null;
    }
  }
  // --- CLAUDE.md 状态水印 ---
  async updateWatermark(info) {
    const p = (0, import_path.join)(this.base, "CLAUDE.md");
    try {
      let content = await (0, import_promises.readFile)(p, "utf-8");
      const watermark = `<!-- flowpilot:watermark -->
${info}
<!-- flowpilot:watermark:end -->`;
      if (content.includes("<!-- flowpilot:watermark -->")) {
        content = content.replace(
          /<!-- flowpilot:watermark -->[\s\S]*?<!-- flowpilot:watermark:end -->/,
          watermark
        );
      } else if (content.includes("<!-- flowpilot:end -->")) {
        content = content.replace(
          "<!-- flowpilot:end -->",
          "<!-- flowpilot:end -->\n\n" + watermark
        );
      } else {
        content += "\n\n" + watermark + "\n";
      }
      await (0, import_promises.writeFile)(p, content, "utf-8");
    } catch {
    }
  }
};

// src/domain/task-store.ts
function makeTaskId(n) {
  return String(n).padStart(3, "0");
}
function cascadeSkip(tasks) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.status !== "pending") continue;
      const blocked = t.deps.some((d) => {
        const dep = tasks.find((x) => x.id === d);
        return dep && (dep.status === "failed" || dep.status === "skipped");
      });
      if (blocked) {
        t.status = "skipped";
        t.summary = "\u4F9D\u8D56\u4EFB\u52A1\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7";
        changed = true;
      }
    }
  }
}
function detectCycles(tasks) {
  const visited = /* @__PURE__ */ new Set();
  const inStack = /* @__PURE__ */ new Set();
  const parent = /* @__PURE__ */ new Map();
  function dfs(id) {
    visited.add(id);
    inStack.add(id);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.deps) {
        if (!visited.has(dep)) {
          parent.set(dep, id);
          const cycle = dfs(dep);
          if (cycle) return cycle;
        } else if (inStack.has(dep)) {
          const path = [dep];
          let cur = id;
          while (cur !== dep) {
            path.push(cur);
            cur = parent.get(cur);
          }
          path.push(dep);
          return path.reverse();
        }
      }
    }
    inStack.delete(id);
    return null;
  }
  for (const t of tasks) {
    if (!visited.has(t.id)) {
      const cycle = dfs(t.id);
      if (cycle) return cycle;
    }
  }
  return null;
}
function findNextTask(tasks) {
  const pending = tasks.filter((t) => t.status === "pending");
  const cycle = detectCycles(pending);
  if (cycle) throw new Error(`\u5FAA\u73AF\u4F9D\u8D56: ${cycle.join(" -> ")}`);
  cascadeSkip(tasks);
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const depsOk = t.deps.every((d) => {
      const dep = tasks.find((x) => x.id === d);
      return dep && dep.status === "done";
    });
    if (depsOk) return t;
  }
  return null;
}
function completeTask(data, id, summary) {
  const t = data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
  t.status = "done";
  t.summary = summary;
  t.timestamps.completed = Date.now();
  data.activeTaskIds = data.activeTaskIds.filter((x) => x !== id);
}
function failTask(data, id, reason) {
  const t = data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
  t.retries++;
  t.timestamps.lastFailed = Date.now();
  if (reason) {
    t.failHistory.push(`[\u7B2C${t.retries}\u6B21] ${reason}`);
  }
  data.activeTaskIds = data.activeTaskIds.filter((x) => x !== id);
  if (t.retries >= 3) {
    t.status = "failed";
    return "skip";
  }
  t.status = "pending";
  return "retry";
}
function resumeProgress(data) {
  const resetIds = [];
  for (const t of data.tasks) {
    if (t.status === "active") {
      t.status = "pending";
      t.timestamps.started = void 0;
      resetIds.push(t.id);
    }
  }
  if (resetIds.length) {
    data.activeTaskIds = [];
    data.status = "running";
    return resetIds;
  }
  if (data.status === "running") return [];
  return [];
}
function findParallelTasks(tasks) {
  const pending = tasks.filter((t) => t.status === "pending");
  const cycle = detectCycles(pending);
  if (cycle) throw new Error(`\u5FAA\u73AF\u4F9D\u8D56: ${cycle.join(" -> ")}`);
  cascadeSkip(tasks);
  return tasks.filter((t) => {
    if (t.status !== "pending") return false;
    return t.deps.every((d) => {
      const dep = tasks.find((x) => x.id === d);
      return dep && dep.status === "done";
    });
  });
}
function isAllDone(tasks) {
  return tasks.every((t) => t.status === "done" || t.status === "skipped" || t.status === "failed");
}

// src/infrastructure/markdown-parser.ts
var TASK_WITH_DEPS_RE = /^(\d+)\.\s+\[\s*([\w-]+)\s*\]\s+(.+)\s+\((?:deps?|依赖)\s*:\s*([^)]*)\)\s*$/i;
var TASK_NO_DEPS_RE = /^(\d+)\.\s+\[\s*([\w-]+)\s*\]\s+(.+?)\s*$/i;
var DESC_RE = /^(?:\t|\s{2,})(.+)$/;
function parseTasksMarkdown(markdown) {
  const lines = markdown.split("\n");
  let name = "";
  let description = "";
  const tasks = [];
  const numToId = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!name && line.startsWith("# ")) {
      name = line.slice(2).trim();
      continue;
    }
    if (name && !description && !line.startsWith("#") && line.trim() && !TASK_WITH_DEPS_RE.test(line) && !TASK_NO_DEPS_RE.test(line)) {
      description = line.trim();
      continue;
    }
    const m = line.match(TASK_WITH_DEPS_RE) || line.match(TASK_NO_DEPS_RE);
    if (m) {
      const userNum = m[1];
      const sysId = makeTaskId(tasks.length + 1);
      numToId.set(userNum.padStart(3, "0"), sysId);
      numToId.set(userNum, sysId);
      const validTypes = /* @__PURE__ */ new Set(["frontend", "backend", "general"]);
      const rawType = m[2].toLowerCase();
      const type = validTypes.has(rawType) ? rawType : "general";
      const title = m[3].trim();
      const rawDeps = m[4] ? m[4].split(",").map((d) => d.trim()).filter(Boolean) : [];
      let desc = "";
      while (i + 1 < lines.length && DESC_RE.test(lines[i + 1])) {
        i++;
        desc += (desc ? "\n" : "") + lines[i].trim();
      }
      tasks.push({ title, type, deps: rawDeps, description: desc });
    }
  }
  for (const t of tasks) {
    t.deps = t.deps.map((d) => numToId.get(d.padStart(3, "0")) || numToId.get(d) || makeTaskId(parseInt(d, 10))).filter(Boolean);
  }
  return { name, description, tasks };
}
function validateDefinition(def) {
  const warnings = [];
  if (!def.name) {
    warnings.push({ type: "error", message: "\u7F3A\u5C11\u5DE5\u4F5C\u6D41\u540D\u79F0\uFF08\u9700\u8981 # \u6807\u9898\uFF09" });
  }
  if (!def.tasks.length) {
    warnings.push({ type: "error", message: "\u672A\u89E3\u6790\u5230\u4EFB\u4F55\u4EFB\u52A1\uFF0C\u8BF7\u68C0\u67E5\u683C\u5F0F: N. [type] \u6807\u9898" });
  }
  const validIds = new Set(def.tasks.map((_, i) => makeTaskId(i + 1)));
  for (let i = 0; i < def.tasks.length; i++) {
    const t = def.tasks[i];
    const taskId = makeTaskId(i + 1);
    for (const d of t.deps) {
      if (!validIds.has(d)) {
        warnings.push({ type: "error", message: `\u4EFB\u52A1 ${taskId} "${t.title}" \u4F9D\u8D56\u4E0D\u5B58\u5728\u7684\u4EFB\u52A1 ID: ${d}` });
      }
    }
    if (t.deps.includes(taskId)) {
      warnings.push({ type: "error", message: `\u4EFB\u52A1 ${taskId} "${t.title}" \u4E0D\u80FD\u4F9D\u8D56\u81EA\u5DF1` });
    }
    const uniqueDeps = new Set(t.deps);
    if (uniqueDeps.size < t.deps.length) {
      warnings.push({ type: "warning", message: `\u4EFB\u52A1 ${taskId} "${t.title}" \u6709\u91CD\u590D\u7684\u4F9D\u8D56\u58F0\u660E` });
    }
  }
  return warnings;
}

// src/application/workflow-service.ts
var WorkflowService = class {
  constructor(repo2, git, verifier, parse) {
    this.repo = repo2;
    this.git = git;
    this.verifier = verifier;
    this.parse = parse;
  }
  /** init: 解析任务markdown → 生成progress/tasks */
  async init(tasksMd, force = false) {
    const existing = await this.repo.loadProgress();
    if (existing && existing.status === "running" && !force) {
      throw new Error(`\u5DF2\u6709\u8FDB\u884C\u4E2D\u7684\u5DE5\u4F5C\u6D41: ${existing.name}\uFF0C\u4F7F\u7528 --force \u8986\u76D6`);
    }
    const def = this.parse(tasksMd);
    const warnings = validateDefinition(def);
    const errors = warnings.filter((w) => w.type === "error");
    if (errors.length) {
      throw new Error(`\u4EFB\u52A1\u5B9A\u4E49\u9519\u8BEF:
${errors.map((e) => `- ${e.message}`).join("\n")}`);
    }
    const tasks = def.tasks.map((t, i) => ({
      id: makeTaskId(i + 1),
      title: t.title,
      description: t.description,
      type: t.type,
      status: "pending",
      deps: t.deps,
      summary: "",
      retries: 0,
      failHistory: [],
      timestamps: { created: Date.now() }
    }));
    const data = {
      name: def.name,
      status: "running",
      activeTaskIds: [],
      tasks,
      startedAt: Date.now()
    };
    await this.repo.saveProgress(data);
    await this.repo.saveTasks(tasksMd);
    await this.repo.saveSummary(`# ${def.name}

${def.description}
`);
    await this.repo.ensureClaudeMd();
    await this.repo.ensureHooks();
    await this.repo.saveConfig(DEFAULT_CONFIG);
    await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "init", detail: data.name });
    return data;
  }
  /** next: 获取下一个可执行任务（含依赖上下文） */
  async next() {
    const config = await this.repo.loadConfig();
    await this.repo.lock(config.lockTimeout);
    try {
      const data = await this.requireProgress();
      if (isAllDone(data.tasks)) return null;
      if (data.activeTaskIds.length > 0) {
        throw new Error(`\u6709 ${data.activeTaskIds.length} \u4E2A\u4EFB\u52A1\u4ECD\u4E3A active \u72B6\u6001\uFF08${data.activeTaskIds.join(",")}\uFF09\uFF0C\u8BF7\u5148\u6267\u884C node flow.js status \u68C0\u67E5\u5E76\u8865 checkpoint\uFF0C\u6216 node flow.js resume \u91CD\u7F6E`);
      }
      const task = findNextTask(data.tasks);
      if (!task) {
        await this.repo.saveProgress(data);
        return null;
      }
      task.status = "active";
      task.timestamps.started = Date.now();
      data.activeTaskIds.push(task.id);
      await this.repo.saveProgress(data);
      await this.repo.saveHeartbeat({ lastCommand: "next", timestamp: (/* @__PURE__ */ new Date()).toISOString(), activeTaskIds: data.activeTaskIds });
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(",")}`);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "next", taskId: task.id, detail: task.title });
      const parts = [];
      const summary = await this.repo.loadSummary();
      if (summary) parts.push(summary);
      for (const depId of task.deps) {
        const ctx = await this.repo.loadTaskContext(depId);
        if (ctx) parts.push(ctx);
      }
      return { task, context: parts.join("\n\n---\n\n") };
    } finally {
      await this.repo.unlock();
    }
  }
  /** nextBatch: 获取所有可并行执行的任务 */
  async nextBatch() {
    const config = await this.repo.loadConfig();
    await this.repo.lock(config.lockTimeout);
    try {
      const data = await this.requireProgress();
      if (isAllDone(data.tasks)) return [];
      if (data.activeTaskIds.length > 0) {
        throw new Error(`\u6709 ${data.activeTaskIds.length} \u4E2A\u4EFB\u52A1\u4ECD\u4E3A active \u72B6\u6001\uFF08${data.activeTaskIds.join(",")}\uFF09\uFF0C\u8BF7\u5148\u6267\u884C node flow.js status \u68C0\u67E5\u5E76\u8865 checkpoint\uFF0C\u6216 node flow.js resume \u91CD\u7F6E`);
      }
      let tasks = findParallelTasks(data.tasks);
      if (!tasks.length) {
        await this.repo.saveProgress(data);
        return [];
      }
      if (config.maxParallel && tasks.length > config.maxParallel) {
        tasks = tasks.slice(0, config.maxParallel);
      }
      for (const t of tasks) {
        t.status = "active";
        t.timestamps.started = Date.now();
        data.activeTaskIds.push(t.id);
      }
      await this.repo.saveProgress(data);
      await this.repo.saveHeartbeat({ lastCommand: "next", timestamp: (/* @__PURE__ */ new Date()).toISOString(), activeTaskIds: data.activeTaskIds });
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(",")}`);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "next", detail: `batch: ${tasks.map((t) => t.id).join(",")}` });
      const summary = await this.repo.loadSummary();
      const results = [];
      for (const task of tasks) {
        const parts = [];
        if (summary) parts.push(summary);
        for (const depId of task.deps) {
          const ctx = await this.repo.loadTaskContext(depId);
          if (ctx) parts.push(ctx);
        }
        results.push({ task, context: parts.join("\n\n---\n\n") });
      }
      return results;
    } finally {
      await this.repo.unlock();
    }
  }
  /** checkpoint: 记录任务完成 */
  async checkpoint(id, detail, files) {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find((t) => t.id === id);
      if (!task) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
      if (task.status !== "active") {
        throw new Error(`\u4EFB\u52A1 ${id} \u72B6\u6001\u4E3A ${task.status}\uFF0C\u53EA\u6709 active \u72B6\u6001\u53EF\u4EE5 checkpoint`);
      }
      if (detail === "FAILED") {
        const reason = detail;
        const result = failTask(data, id, reason);
        await this.repo.saveTaskContext(id, `# task-${id}: ${task.title}

[FAILED] \u7B2C${task.retries}\u6B21\u5931\u8D25
`);
        await this.repo.saveProgress(data);
        await this.repo.saveHeartbeat({ lastCommand: "checkpoint", timestamp: (/* @__PURE__ */ new Date()).toISOString(), activeTaskIds: data.activeTaskIds });
        await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(",") || "\u65E0"}`);
        await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "fail", taskId: id, detail: `\u7B2C${task.retries}\u6B21\u5931\u8D25` });
        return result === "retry" ? `\u4EFB\u52A1 ${id} \u5931\u8D25(\u7B2C${task.retries}\u6B21)\uFF0C\u5C06\u91CD\u8BD5` : `\u4EFB\u52A1 ${id} \u8FDE\u7EED\u5931\u8D253\u6B21\uFF0C\u5DF2\u8DF3\u8FC7`;
      }
      if (!detail.trim()) throw new Error(`\u4EFB\u52A1 ${id} checkpoint\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A`);
      const summaryLine = detail.split("\n")[0].slice(0, 80);
      completeTask(data, id, summaryLine);
      await this.repo.saveProgress(data);
      await this.repo.saveTaskContext(id, `# task-${id}: ${task.title}

${detail}
`);
      await this.updateSummary(data);
      const config = await this.repo.loadConfig();
      let commitMsg = "";
      if (config.autoCommit) {
        const commitErr = this.git.commit(id, task.title, summaryLine, files);
        if (commitErr) {
          commitMsg = `
[git\u63D0\u4EA4\u5931\u8D25] ${commitErr}
\u8BF7\u6839\u636E\u9519\u8BEF\u4FEE\u590D\u540E\u624B\u52A8\u6267\u884C git add -A && git commit`;
        } else {
          commitMsg = " [\u5DF2\u81EA\u52A8\u63D0\u4EA4]";
        }
      }
      await this.repo.saveHeartbeat({ lastCommand: "checkpoint", timestamp: (/* @__PURE__ */ new Date()).toISOString(), activeTaskIds: data.activeTaskIds });
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(",") || "\u65E0"}`);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "checkpoint", taskId: id, detail: summaryLine });
      const doneCount = data.tasks.filter((t) => t.status === "done").length;
      let msg = `\u4EFB\u52A1 ${id} \u5B8C\u6210 (${doneCount}/${data.tasks.length})${commitMsg}`;
      return isAllDone(data.tasks) ? msg + "\n\u5168\u90E8\u4EFB\u52A1\u5DF2\u5B8C\u6210\uFF0C\u8BF7\u6267\u884C node flow.js finish \u8FDB\u884C\u6536\u5C3E" : msg;
    } finally {
      await this.repo.unlock();
    }
  }
  /** resume: 中断恢复 */
  async resume() {
    await this.repo.lock();
    try {
      const data = await this.repo.loadProgress();
      if (!data || data.status !== "running" && data.status !== "idle") {
        if (data?.status === "finishing") {
          return "\u6B63\u5728\u6536\u5C3E\u9636\u6BB5\uFF0C\u8BF7\u6267\u884C node flow.js finish";
        }
        return "\u6CA1\u6709\u9700\u8981\u6062\u590D\u7684\u5DE5\u4F5C\u6D41\uFF0C\u4F7F\u7528 flow init \u5F00\u59CB\u65B0\u6D41\u7A0B";
      }
      if (data.status === "idle") {
        data.status = "running";
        await this.repo.saveProgress(data);
      }
      const resetIds = resumeProgress(data);
      await this.repo.saveProgress(data);
      if (resetIds.length) {
        this.git.cleanup();
        this.git.pruneStash();
      }
      const summary = await this.repo.loadSummary();
      const doneCount = data.tasks.filter((t) => t.status === "done").length;
      const total = data.tasks.length;
      const lines = [
        `\u6062\u590D\u5DE5\u4F5C\u6D41: ${data.name}`,
        `\u8FDB\u5EA6: ${doneCount}/${total}`
      ];
      if (resetIds.length) {
        lines.push(`\u4E2D\u65AD\u4EFB\u52A1 ${resetIds.join(", ")} \u5DF2\u91CD\u7F6E\uFF0C\u5C06\u91CD\u65B0\u6267\u884C`);
      } else {
        lines.push("\u7EE7\u7EED\u6267\u884C");
      }
      lines.push("");
      lines.push("--- \u4EFB\u52A1\u72B6\u6001 ---");
      for (const t of data.tasks) {
        const icon = { pending: "[ ]", active: "[>]", done: "[x]", skipped: "[-]", failed: "[!]" }[t.status] || "[ ]";
        lines.push(`${icon} ${t.id} [${t.type}] ${t.title}${t.summary ? " - " + t.summary : ""}`);
      }
      if (summary) {
        lines.push("");
        lines.push("--- \u9879\u76EE\u6458\u8981 ---");
        lines.push(summary);
      }
      lines.push("");
      lines.push("\u8BF7\u6267\u884C node flow.js next --batch \u7EE7\u7EED");
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "resume", detail: `\u91CD\u7F6E: ${resetIds.join(",") || "\u65E0"}` });
      await this.repo.saveHeartbeat({ lastCommand: "resume", timestamp: (/* @__PURE__ */ new Date()).toISOString(), activeTaskIds: [] });
      return lines.join("\n");
    } finally {
      this.repo.unlock();
    }
  }
  /** add: 追加任务 */
  async add(title, type, description = "", deps = []) {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const maxNum = data.tasks.reduce((m, t) => Math.max(m, parseInt(t.id, 10)), 0);
      const id = makeTaskId(maxNum + 1);
      for (const d of deps) {
        if (!data.tasks.find((t) => t.id === d)) {
          throw new Error(`\u4F9D\u8D56\u4EFB\u52A1 ${d} \u4E0D\u5B58\u5728`);
        }
      }
      data.tasks.push({
        id,
        title,
        description,
        type,
        status: "pending",
        deps,
        summary: "",
        retries: 0,
        failHistory: [],
        timestamps: { created: Date.now() }
      });
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "add", taskId: id, detail: title });
      return `\u5DF2\u6DFB\u52A0\u4EFB\u52A1 ${id}: ${title}`;
    } finally {
      await this.repo.unlock();
    }
  }
  /** skip: 手动跳过任务 */
  async skip(id) {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find((t) => t.id === id);
      if (!task) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
      if (task.status === "done") return `\u4EFB\u52A1 ${id} \u5DF2\u5B8C\u6210\uFF0C\u65E0\u9700\u8DF3\u8FC7`;
      const warn = task.status === "active" ? "\uFF08\u8B66\u544A: \u8BE5\u4EFB\u52A1\u4E3A active \u72B6\u6001\uFF0C\u5B50Agent\u53EF\u80FD\u4ECD\u5728\u8FD0\u884C\uFF09" : "";
      task.status = "skipped";
      task.summary = "\u624B\u52A8\u8DF3\u8FC7";
      data.activeTaskIds = data.activeTaskIds.filter((x) => x !== id);
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "skip", taskId: id, detail: task.title });
      return `\u5DF2\u8DF3\u8FC7\u4EFB\u52A1 ${id}: ${task.title}${warn}`;
    } finally {
      await this.repo.unlock();
    }
  }
  /** setup: 项目接管模式 - 写入CLAUDE.md */
  async setup() {
    const existing = await this.repo.loadProgress();
    const wrote = await this.repo.ensureClaudeMd();
    await this.repo.ensureHooks();
    const lines = [];
    if (existing && (existing.status === "running" || existing.status === "finishing")) {
      const done = existing.tasks.filter((t) => t.status === "done").length;
      lines.push(`\u68C0\u6D4B\u5230\u8FDB\u884C\u4E2D\u7684\u5DE5\u4F5C\u6D41: ${existing.name}`);
      lines.push(`\u8FDB\u5EA6: ${done}/${existing.tasks.length}`);
      if (existing.status === "finishing") {
        lines.push("\u72B6\u6001: \u6536\u5C3E\u9636\u6BB5\uFF0C\u6267\u884C node flow.js finish \u7EE7\u7EED");
      } else {
        lines.push("\u6267\u884C node flow.js resume \u7EE7\u7EED");
      }
    } else {
      lines.push("\u9879\u76EE\u5DF2\u63A5\u7BA1\uFF0C\u5DE5\u4F5C\u6D41\u5DE5\u5177\u5C31\u7EEA");
      lines.push("\u7B49\u5F85\u9700\u6C42\u8F93\u5165\uFF08\u6587\u6863\u6216\u5BF9\u8BDD\u63CF\u8FF0\uFF09");
    }
    lines.push("");
    if (wrote) lines.push("CLAUDE.md \u5DF2\u66F4\u65B0: \u6DFB\u52A0\u4E86\u5DE5\u4F5C\u6D41\u534F\u8BAE");
    lines.push("\u63CF\u8FF0\u4F60\u7684\u5F00\u53D1\u4EFB\u52A1\u5373\u53EF\u542F\u52A8\u5168\u81EA\u52A8\u5F00\u53D1");
    return lines.join("\n");
  }
  /** review: 标记已通过code-review，解锁finish */
  async review() {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      if (data.status !== "finishing") return "\u5F53\u524D\u4E0D\u5728 finishing \u9636\u6BB5";
      data.reviewDone = true;
      await this.repo.saveProgress(data);
      return "Code review \u5DF2\u6807\u8BB0\u5B8C\u6210\uFF0C\u8BF7\u6267\u884C node flow.js finish \u5B8C\u6210\u6536\u5C3E";
    } finally {
      this.repo.unlock();
    }
  }
  /** finish: 智能收尾 - 先verify，review后置 */
  async finish() {
    await this.repo.lock();
    let data;
    let config;
    try {
      data = await this.requireProgress();
      config = await this.repo.loadConfig();
      if (data.status === "idle" || data.status === "completed") return "\u6CA1\u6709\u6D3B\u8DC3\u7684\u5DE5\u4F5C\u6D41";
      if (!isAllDone(data.tasks)) return "\u8FD8\u6709\u672A\u5B8C\u6210\u7684\u4EFB\u52A1\uFF0C\u8BF7\u5148\u5B8C\u6210\u6240\u6709\u4EFB\u52A1";
      if (data.status !== "finishing") {
        data.status = "finishing";
        await this.repo.saveProgress(data);
      }
    } finally {
      this.repo.unlock();
    }
    const result = this.verifier.verify(config);
    if (!result.passed) {
      return `\u9A8C\u8BC1\u5931\u8D25:
${result.error}

\u6267\u884C\u7684\u811A\u672C: ${result.scripts.join(", ")}
\u8BF7\u4FEE\u590D\u540E\u91CD\u8BD5 finish`;
    }
    await this.repo.lock();
    try {
      data = await this.requireProgress();
      if (!data.reviewDone) {
        data.status = "finishing";
        await this.repo.saveProgress(data);
        return "\u9A8C\u8BC1\u901A\u8FC7\uFF0C\u8BF7\u6D3E\u5B50Agent\u6267\u884C code-review\n\u5B8C\u6210\u540E\u6267\u884C node flow.js review \u6807\u8BB0";
      }
      const done = data.tasks.filter((t) => t.status === "done").length;
      const skipped = data.tasks.filter((t) => t.status === "skipped").length;
      const failed = data.tasks.filter((t) => t.status === "failed").length;
      if (config.autoCommit) {
        const commitErr = this.git.commit("finish", data.name, `\u5B8C\u6210: ${done}/${data.tasks.length}`);
        if (commitErr) {
          return `\u9A8C\u8BC1\u901A\u8FC7\u4F46git\u63D0\u4EA4\u5931\u8D25: ${commitErr}`;
        }
      }
      await this.repo.removeClaudeMd();
      await this.repo.removeHooks();
      await this.repo.clearAll();
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "finish", detail: `done=${done} skipped=${skipped} failed=${failed}` });
      return `\u5DE5\u4F5C\u6D41\u5B8C\u6210\uFF01
\u5B8C\u6210: ${done} | \u8DF3\u8FC7: ${skipped} | \u5931\u8D25: ${failed}
\u9A8C\u8BC1: ${result.scripts.join(", ") || "\u65E0"}`;
    } finally {
      this.repo.unlock();
    }
  }
  /** status: 全局进度 */
  async status() {
    return this.repo.loadProgress();
  }
  /** edit: 编辑 pending 状态的任务 */
  async edit(id, updates) {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find((t) => t.id === id);
      if (!task) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
      if (task.status !== "pending") throw new Error(`\u53EA\u80FD\u7F16\u8F91 pending \u72B6\u6001\u7684\u4EFB\u52A1\uFF08\u5F53\u524D: ${task.status}\uFF09`);
      if (updates.title) task.title = updates.title;
      if (updates.description !== void 0) task.description = updates.description;
      if (updates.type) task.type = updates.type;
      if (updates.deps) {
        for (const d of updates.deps) {
          if (!data.tasks.find((t) => t.id === d)) throw new Error(`\u4F9D\u8D56\u4EFB\u52A1 ${d} \u4E0D\u5B58\u5728`);
          if (d === id) throw new Error("\u4E0D\u80FD\u4F9D\u8D56\u81EA\u5DF1");
        }
        task.deps = updates.deps;
      }
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "edit", taskId: id, detail: JSON.stringify(updates) });
      return `\u5DF2\u66F4\u65B0\u4EFB\u52A1 ${id}`;
    } finally {
      this.repo.unlock();
    }
  }
  /** log: 查看执行历史 */
  async log() {
    const history = await this.repo.loadHistory();
    if (!history.length) return "\u6682\u65E0\u6267\u884C\u5386\u53F2";
    const lines = ["=== \u6267\u884C\u5386\u53F2 ===", ""];
    for (const h of history.slice(-30)) {
      const taskPart = h.taskId ? ` [${h.taskId}]` : "";
      lines.push(`${h.ts} ${h.event}${taskPart} ${h.detail}`);
    }
    return lines.join("\n");
  }
  /** show: 查看任务详情 */
  async show(id) {
    const data = await this.requireProgress();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`\u4EFB\u52A1 ${id} \u4E0D\u5B58\u5728`);
    const context = await this.repo.loadTaskContext(id);
    const lines = [
      `=== \u4EFB\u52A1 ${id} \u8BE6\u60C5 ===`,
      `\u6807\u9898: ${task.title}`,
      `\u7C7B\u578B: ${task.type}`,
      `\u72B6\u6001: ${task.status}`,
      `\u4F9D\u8D56: ${task.deps.length ? task.deps.join(", ") : "\u65E0"}`,
      `\u91CD\u8BD5: ${task.retries}/${3}`
    ];
    if (task.description) lines.push(`\u63CF\u8FF0: ${task.description}`);
    if (task.summary) lines.push(`\u6458\u8981: ${task.summary}`);
    if (task.timestamps.started) lines.push(`\u5F00\u59CB: ${new Date(task.timestamps.started).toISOString()}`);
    if (task.timestamps.completed) lines.push(`\u5B8C\u6210: ${new Date(task.timestamps.completed).toISOString()}`);
    if (task.failHistory.length) {
      lines.push("", "--- \u5931\u8D25\u8BB0\u5F55 ---");
      task.failHistory.forEach((f) => lines.push(`  ${f}`));
    }
    if (context) {
      lines.push("", "--- \u4EA7\u51FA\u4E0A\u4E0B\u6587 ---", context);
    }
    return lines.join("\n");
  }
  /** pause: 手动暂停工作流 */
  async pause() {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      if (data.status !== "running") return "\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u5DE5\u4F5C\u6D41";
      for (const t of data.tasks) {
        if (t.status === "active") {
          t.status = "pending";
          t.timestamps.started = void 0;
        }
      }
      data.activeTaskIds = [];
      data.status = "idle";
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: (/* @__PURE__ */ new Date()).toISOString(), event: "pause", detail: "\u624B\u52A8\u6682\u505C" });
      return "\u5DE5\u4F5C\u6D41\u5DF2\u6682\u505C\uFF0C\u4F7F\u7528 resume \u7EE7\u7EED";
    } finally {
      this.repo.unlock();
    }
  }
  /** 滚动摘要：每次checkpoint追加，压缩策略使用 config 阈值 */
  async updateSummary(data) {
    const config = await this.repo.loadConfig();
    const done = data.tasks.filter((t) => t.status === "done");
    const lines = [`# ${data.name}
`];
    if (done.length > config.summaryCompressThreshold) {
      const groups = /* @__PURE__ */ new Map();
      for (const t of done) {
        const arr = groups.get(t.type) || [];
        arr.push(t);
        groups.set(t.type, arr);
      }
      for (const [type, tasks] of groups) {
        lines.push(`## ${type} (${tasks.length}\u9879\u5B8C\u6210)`);
        for (const t of tasks) {
          lines.push(`- ${t.id}: ${t.title} \u2192 ${t.summary}`);
        }
        lines.push("");
      }
    } else {
      for (const t of done) {
        lines.push(`- [${t.type}] ${t.id}: ${t.title}: ${t.summary}`);
      }
    }
    await this.repo.saveSummary(lines.join("\n") + "\n");
  }
  async requireProgress() {
    const data = await this.repo.loadProgress();
    if (!data) throw new Error("\u65E0\u6D3B\u8DC3\u5DE5\u4F5C\u6D41\uFF0C\u8BF7\u5148 node flow.js init");
    return data;
  }
};

// src/interfaces/cli.ts
var import_fs2 = require("fs");
var import_path2 = require("path");

// src/interfaces/formatter.ts
var ICON = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  skipped: "[-]",
  failed: "[!]"
};
function progressBar(done, total, width = 20) {
  const pct = total ? Math.round(done / total * 100) : 0;
  const filled = Math.round(done / total * width);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  return `[${bar}] ${pct}%`;
}
function formatStatus(data) {
  const done = data.tasks.filter((t) => t.status === "done").length;
  const lines = [
    `=== ${data.name} ===`,
    `\u72B6\u6001: ${data.status} | \u8FDB\u5EA6: ${progressBar(done, data.tasks.length)} (${done}/${data.tasks.length})`
  ];
  if (data.activeTaskIds.length) {
    lines.push(`\u6D3B\u8DC3: ${data.activeTaskIds.join(", ")}`);
  }
  lines.push("");
  for (const t of data.tasks) {
    lines.push(`${ICON[t.status] ?? "[ ]"} ${t.id} [${t.type}] ${t.title}${t.summary ? " - " + t.summary : ""}`);
  }
  return lines.join("\n");
}
function formatTask(task, context) {
  const lines = [
    `--- \u4EFB\u52A1 ${task.id} ---`,
    `\u6807\u9898: ${task.title}`,
    `\u7C7B\u578B: ${task.type}`,
    `\u4F9D\u8D56: ${task.deps.length ? task.deps.join(", ") : "\u65E0"}`
  ];
  if (task.description) {
    lines.push(`\u63CF\u8FF0: ${task.description}`);
  }
  lines.push("", "--- checkpoint\u6307\u4EE4\uFF08\u5FC5\u987B\u5305\u542B\u5728sub-agent prompt\u4E2D\uFF09 ---");
  lines.push(`\u5B8C\u6210\u65F6: echo '\u4E00\u53E5\u8BDD\u6458\u8981' | node flow.js checkpoint ${task.id} --files <changed-file-1> <changed-file-2>`);
  lines.push(`\u5931\u8D25\u65F6: echo 'FAILED' | node flow.js checkpoint ${task.id}`);
  if (context) {
    lines.push("", "--- \u4E0A\u4E0B\u6587 ---", context);
  }
  return lines.join("\n");
}
function formatBatch(items) {
  const lines = [`=== \u5E76\u884C\u4EFB\u52A1\u6279\u6B21 (${items.length}\u4E2A) ===`, ""];
  for (const { task, context } of items) {
    lines.push(formatTask(task, context), "");
  }
  return lines.join("\n");
}

// src/interfaces/stdin.ts
function isTTY() {
  return process.stdin.isTTY === true;
}
function readStdinIfPiped(timeout = 3e4) {
  if (isTTY()) return Promise.resolve("");
  return new Promise((resolve2, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve2("");
    }, timeout);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve2(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// src/interfaces/cli.ts
var CLI = class {
  constructor(service2) {
    this.service = service2;
  }
  async run(argv) {
    const args = argv.slice(2);
    try {
      const output = await this.dispatch(args);
      process.stdout.write(output + "\n");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`\u9519\u8BEF: ${msg}
`);
      if (args.includes("--verbose") && e instanceof Error && e.stack) {
        process.stderr.write(e.stack + "\n");
      }
      process.exitCode = 1;
    }
  }
  async dispatch(args) {
    const [cmd, ...rest] = args;
    const s = this.service;
    switch (cmd) {
      case "init": {
        const force = rest.includes("--force");
        const md = await readStdinIfPiped();
        let out;
        if (md.trim()) {
          const data = await s.init(md, force);
          out = `\u5DF2\u521D\u59CB\u5316\u5DE5\u4F5C\u6D41: ${data.name} (${data.tasks.length} \u4E2A\u4EFB\u52A1)`;
        } else {
          out = await s.setup();
        }
        return out + "\n\n\u63D0\u793A: \u5EFA\u8BAE\u5148\u901A\u8FC7 /plugin \u5B89\u88C5\u63D2\u4EF6 superpowers\u3001frontend-design\u3001feature-dev\u3001code-review\u3001context7\uFF0C\u672A\u5B89\u88C5\u5219\u5B50Agent\u65E0\u6CD5\u4F7F\u7528\u4E13\u4E1A\u6280\u80FD\uFF0C\u529F\u80FD\u4F1A\u964D\u7EA7";
      }
      case "next": {
        if (rest.includes("--batch")) {
          const items = await s.nextBatch();
          if (!items.length) return "\u5168\u90E8\u5B8C\u6210";
          return formatBatch(items);
        }
        const result = await s.next();
        if (!result) return "\u5168\u90E8\u5B8C\u6210";
        return formatTask(result.task, result.context);
      }
      case "checkpoint": {
        const id = rest[0];
        if (!id) throw new Error("\u9700\u8981\u4EFB\u52A1ID");
        const filesIdx = rest.indexOf("--files");
        const fileIdx = rest.indexOf("--file");
        let detail;
        let files;
        if (filesIdx >= 0) {
          files = [];
          for (let i = filesIdx + 1; i < rest.length && !rest[i].startsWith("--"); i++) {
            files.push(rest[i]);
          }
        }
        if (fileIdx >= 0 && rest[fileIdx + 1]) {
          const filePath = (0, import_path2.resolve)(rest[fileIdx + 1]);
          if ((0, import_path2.relative)(process.cwd(), filePath).startsWith("..")) throw new Error("--file \u8DEF\u5F84\u4E0D\u80FD\u8D85\u51FA\u9879\u76EE\u76EE\u5F55");
          detail = (0, import_fs2.readFileSync)(filePath, "utf-8");
        } else if (rest.length > 1 && fileIdx < 0 && filesIdx < 0) {
          detail = rest.slice(1).join(" ");
        } else {
          detail = await readStdinIfPiped();
        }
        return await s.checkpoint(id, detail.trim(), files);
      }
      case "skip": {
        const id = rest[0];
        if (!id) throw new Error("\u9700\u8981\u4EFB\u52A1ID");
        return await s.skip(id);
      }
      case "status": {
        const data = await s.status();
        if (!data) return "\u65E0\u6D3B\u8DC3\u5DE5\u4F5C\u6D41";
        return formatStatus(data);
      }
      case "review":
        return await s.review();
      case "finish":
        return await s.finish();
      case "resume":
        return await s.resume();
      case "add": {
        const depsIdx = rest.indexOf("--deps");
        let deps = [];
        if (depsIdx !== -1 && rest[depsIdx + 1]) {
          deps = rest[depsIdx + 1].split(",").map((d) => d.trim()).filter(Boolean);
          rest.splice(depsIdx, 2);
        }
        const descIdx = rest.indexOf("--desc");
        let desc = "";
        if (descIdx !== -1 && rest[descIdx + 1]) {
          desc = rest[descIdx + 1];
          rest.splice(descIdx, 2);
        }
        const typeIdx = rest.indexOf("--type");
        let type = "general";
        if (typeIdx !== -1 && rest[typeIdx + 1]) {
          type = rest[typeIdx + 1];
          if (!VALID_TASK_TYPES.has(type)) throw new Error(`\u65E0\u6548\u7684\u7C7B\u578B: ${type}`);
          rest.splice(typeIdx, 2);
        }
        const title = rest.join(" ");
        if (!title) throw new Error("\u9700\u8981\u4EFB\u52A1\u6807\u9898");
        return s.add(title, type, desc, deps);
      }
      case "edit": {
        const id = rest[0];
        if (!id) throw new Error("\u9700\u8981\u4EFB\u52A1ID");
        const updates = {};
        const titleIdx = rest.indexOf("--title");
        if (titleIdx !== -1 && rest[titleIdx + 1]) updates.title = rest[titleIdx + 1];
        const descIdx = rest.indexOf("--desc");
        if (descIdx !== -1 && rest[descIdx + 1]) updates.description = rest[descIdx + 1];
        const typeIdx = rest.indexOf("--type");
        if (typeIdx !== -1 && rest[typeIdx + 1]) {
          const t = rest[typeIdx + 1];
          if (!VALID_TASK_TYPES.has(t)) throw new Error(`\u65E0\u6548\u7684\u7C7B\u578B: ${t}\uFF0C\u53EF\u9009: ${[...VALID_TASK_TYPES].join(", ")}`);
          updates.type = t;
        }
        const depsIdx = rest.indexOf("--deps");
        if (depsIdx !== -1 && rest[depsIdx + 1]) {
          updates.deps = rest[depsIdx + 1].split(",").map((d) => d.trim()).filter(Boolean);
        }
        if (!Object.keys(updates).length) throw new Error("\u81F3\u5C11\u6307\u5B9A\u4E00\u4E2A\u4FEE\u6539\u9879: --title, --desc, --type, --deps");
        return s.edit(id, updates);
      }
      case "show": {
        const id = rest[0];
        if (!id) throw new Error("\u9700\u8981\u4EFB\u52A1ID");
        return s.show(id);
      }
      case "log":
        return s.log();
      case "pause":
        return s.pause();
      default:
        return USAGE;
    }
  }
};
var USAGE = `\u7528\u6CD5: node flow.js <command>
  init [--force]       \u521D\u59CB\u5316\u5DE5\u4F5C\u6D41 (stdin\u4F20\u5165\u4EFB\u52A1markdown\uFF0C\u65E0stdin\u5219\u63A5\u7BA1\u9879\u76EE)
  next [--batch]       \u83B7\u53D6\u4E0B\u4E00\u4E2A\u5F85\u6267\u884C\u4EFB\u52A1 (--batch \u8FD4\u56DE\u6240\u6709\u53EF\u5E76\u884C\u4EFB\u52A1)
  checkpoint <id>      \u8BB0\u5F55\u4EFB\u52A1\u5B8C\u6210 [--file <path> | stdin | \u5185\u8054\u6587\u672C] [--files f1 f2 ...]
  skip <id>            \u624B\u52A8\u8DF3\u8FC7\u4EFB\u52A1
  edit <id>            \u4FEE\u6539\u4EFB\u52A1 [--title X] [--desc X] [--type X] [--deps 001,002]
  show <id>            \u67E5\u770B\u4EFB\u52A1\u8BE6\u60C5
  log                  \u67E5\u770B\u6267\u884C\u5386\u53F2
  pause                \u6682\u505C\u5DE5\u4F5C\u6D41\uFF08resume \u6062\u590D\uFF09
  review               \u6807\u8BB0code-review\u5DF2\u5B8C\u6210 (finish\u524D\u5FC5\u987B\u6267\u884C)
  finish               \u667A\u80FD\u6536\u5C3E (\u9A8C\u8BC1+\u603B\u7ED3+\u56DE\u5230\u5F85\u547D\uFF0C\u9700\u5148review)
  status               \u67E5\u770B\u5168\u5C40\u8FDB\u5EA6
  resume               \u4E2D\u65AD\u6062\u590D
  add <\u63CF\u8FF0>           \u8FFD\u52A0\u4EFB\u52A1 [--type frontend|backend|general] [--desc X] [--deps 001,002]`;

// src/main.ts
var repo = new FsWorkflowRepository(process.cwd());
var service = new WorkflowService(repo, repo, repo, parseTasksMarkdown);
var cli = new CLI(service);
cli.run(process.argv);
