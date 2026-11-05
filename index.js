/**
 * Writing Style Learner — Host plugin.
 *
 * Learns a document's writing style (text style, figures, numbering, tables,
 * formatting, …) into a durable profile and injects it into every model step,
 * so generated writing stays consistent — even across long contexts and
 * sessions. The model extracts the style and calls `save_writing_style` with
 * the resulting profile; the plugin persists it and re-injects it forever.
 *
 * Persistence is a plain JSON file under $DSH_HOME (builtin node:fs only), so
 * it survives restarts and never depends on storage-service load ordering.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const name = "writing-style-learner";

export const inject = ["tools", "systemPrompt"];

const STORE_VERSION = 1;

const SECTION_TITLES = {
  summary: "风格概述 · Summary",
  text_style: "文本风格特征 · Text style",
  illustrations: "插图特征 · Illustrations & figures",
  figures: "插图特征 · Illustrations & figures",
  images: "插图特征 · Illustrations & figures",
  numbering: "编号特征 · Numbering",
  tables: "表格特征 · Tables",
  fonts: "字体特征 · Fonts",
  structure: "结构 · Structure",
  formatting: "格式特征 · Formatting",
  rules: "写作规则 · Rules",
  examples: "风格示例 · Examples",
};

// Always-on guidance: tells the model WHEN to call the writing-style tools.
const GUIDANCE = `# 写作风格工具使用指引

本会话提供写作风格学习器工具（save_writing_style / show_writing_style / list_writing_styles / activate_writing_style / clear_writing_style）。它把任意写作样例的风格固化成持久档案，并在之后所有写作中保持一致。

**学习是对话驱动的，不需要任何固定输入格式**：
- 用户说「学习 / 模仿 / 参照 / 按照这个风格 / 仿写 / 风格迁移 / 学一下这篇」，或直接贴一段文字、发一个文档、说「照这个写」→ 直接从对话内容里解析风格，再调用 save_writing_style 保存并激活；
- 用户执行 /writing-style 之后接着聊，就把接下来的内容（贴出的文字、附件，或此前已经成稿的正文）当作样例，不要反过来要求用户按某种格式填表提交；
- 样例可以是任何文体：实验报告、思想汇报、学术论文、公文、邮件、文案、小说等；
- 用户要求查看 / 切换 / 删除写作风格 → 调用 show_writing_style / list_writing_styles / activate_writing_style / clear_writing_style；
- 已有激活风格时，所有生成内容都要遵循它。

风格档案应尽量具体、可执行；不适用的维度（如思想汇报没有表格/插图）写「无」即可。`;

function sectionHeading(key) {
  return SECTION_TITLES[key] ?? (String(key).charAt(0).toUpperCase() + String(key).slice(1));
}

function formatValue(value, depth = 0) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "（未说明）";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const inner = formatValue(item, depth + 1);
        const lines = inner.split("\n");
        return "- " + lines[0] + lines.slice(1).map((l) => "  " + l).join("\n");
      })
      .join("\n");
  }
  if (typeof value === "object") {
    if (depth >= 2) return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
    return Object.entries(value)
      .map(([k, v]) => {
        const inner = formatValue(v, depth + 1);
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
          return "- **" + k + "**: " + inner;
        }
        return "- **" + k + "**:\n" + inner.split("\n").map((l) => "  " + l).join("\n");
      })
      .join("\n");
  }
  return String(value);
}

function truncateUtf8Bytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "\n\n（风格档案过长，已按字节预算截断）";
}

function renderStylePrompt(profile, maxBytes) {
  if (!profile) return "";
  const head = [
    "# 当前写作风格 · Active Writing Style",
    "",
    `你正在以「${profile.title}」这一写作风格写作。请在本次会话生成的所有内容（正文、标题、列表、表格、图注、编号与排版）中严格遵循以下特征；即使用户没有再次提醒、或对话与文档变得很长，也不要遗忘或漂移这些风格。若用户明确要求改用其他风格，以用户最新指令为准。`,
    "",
  ];
  const body = [];
  const p = profile.profile;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    for (const [key, value] of Object.entries(p)) {
      body.push("## " + sectionHeading(key));
      body.push("");
      body.push(formatValue(value));
      body.push("");
    }
  }
  return truncateUtf8Bytes(head.concat(body).join("\n").trim(), maxBytes);
}

// Shared tool output: accept any JSON object, render as pretty text.
const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

function optionalString(value) {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

/** Turn an arbitrary label into a safe single path segment (no slashes / reserved chars). */
function sanitizeSegment(value) {
  const s = String(value == null ? "" : value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\.+$/, "");
  return s === "" || s === "." || s === ".." ? "default" : s;
}

function emptyStore() {
  return { version: STORE_VERSION, activeName: null, profiles: {} };
}

function readStore(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data === "object" && data.profiles && typeof data.profiles === "object") {
      return {
        version: STORE_VERSION,
        activeName: typeof data.activeName === "string" ? data.activeName : null,
        profiles: data.profiles,
      };
    }
  } catch {}
  return emptyStore();
}

function writeStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function apply(ctx, config = {}) {
  const sectionName =
    typeof config.sectionName === "string" && config.sectionName ? config.sectionName : "writing-style";
  const sectionOrder =
    typeof config.sectionOrder === "number" && Number.isFinite(config.sectionOrder) ? config.sectionOrder : 100;
  const maxProfileBytes =
    typeof config.maxProfileBytes === "number" && config.maxProfileBytes > 0
      ? Math.floor(config.maxProfileBytes)
      : 24000;
  const autoWriteJson = config.autoWriteJson === true;
  const jsonFileName =
    typeof config.jsonFileName === "string" && config.jsonFileName ? config.jsonFileName : "writing-style-profile.json";

  // Optional filesystem service, for the explicit `file_path` export.
  let fs = null;
  try {
    fs = typeof ctx.get === "function" ? ctx.get("fs") : undefined;
  } catch {}
  if (!fs) {
    try {
      fs = ctx.fs;
    } catch {}
  }

  // --- per-session store: Writing-Style lives in the session's workspace; $DSH_HOME is the fallback ---
  const homeDir = process.env.DSH_HOME || join(homedir(), ".dsh");
  let defaultWorkspaceDir = "";
  try {
    const wd = ctx.get("workingDirectory");
    if (wd && typeof wd.defaultDirectory === "string" && wd.defaultDirectory) defaultWorkspaceDir = wd.defaultDirectory;
  } catch {}
  const rootDir = defaultWorkspaceDir && existsSync(defaultWorkspaceDir) ? defaultWorkspaceDir : homeDir;
  const customDir = typeof config.dataDir === "string" && config.dataDir ? config.dataDir : undefined;

  // Resolve the calling session's workspace (per tool call), falling back to the default.
  function resolveWorkspaceDir(exec) {
    try {
      const wd = ctx.get("workingDirectory");
      const session = exec && exec.agent && exec.agent.session;
      if (wd && session && typeof wd.get === "function") {
        const dir = wd.get(session);
        if (typeof dir === "string" && dir) return dir;
      }
    } catch {}
    return "";
  }

  function dataDirFor(exec) {
    const base = resolveWorkspaceDir(exec) || rootDir;
    return customDir ? (isAbsolute(customDir) ? customDir : join(base, customDir)) : join(base, "Writing-Style");
  }

  function openStore(exec) {
    const dir = dataDirFor(exec);
    const path = join(dir, "profiles.json");
    return { dir, path, store: readStore(path) };
  }

  const active = { current: null };
  // Initial injection source (before any session-scoped tool call).
  {
    const initialDir = customDir
      ? isAbsolute(customDir)
        ? customDir
        : join(rootDir, customDir)
      : join(rootDir, "Writing-Style");
    const s = readStore(join(initialDir, "profiles.json"));
    if (s.activeName && s.profiles[s.activeName] && typeof s.profiles[s.activeName] === "object") {
      const rec = s.profiles[s.activeName];
      active.current = { name: s.activeName, title: rec.title, profile: rec.profile, updatedAt: rec.updatedAt };
    }
  }

  // --- system prompt injection (re-rendered every step → never forgotten) ---
  ctx.systemPrompt.section({
    name: sectionName,
    order: sectionOrder,
    text: () => renderStylePrompt(active.current, maxProfileBytes),
  });
  // Always-on guidance so the model knows to invoke the tools on "学习/模仿/…".
  ctx.systemPrompt.section({
    name: "writing-style:guidance",
    order: sectionOrder + 1,
    text: GUIDANCE,
  });

  async function writeJsonFile(path, payload) {
    if (!fs) throw new Error("filesystem service unavailable");
    const target = await fs.resolve(path);
    await fs.writeText(target, JSON.stringify(payload, null, 2) + "\n");
    return fs.processPath(target);
  }

  // ---- save_writing_style ----
  ctx.tools.register({
    name: "save_writing_style",
    description:
      "通用写作风格学习器：分析任意写作样例（实验报告、思想汇报、学术论文、公文、邮件、文案、小说等），把它的写作风格固化为持久档案并立即激活。之后每一步都会把该风格注入系统提示，保证后续写作（正文、标题、列表、表格、图注、编号、字体、排版）保持一致，长文档/长对话也不遗忘。当用户说「学习/模仿/参照/按照这个风格/仿写/风格迁移」或提供写作样例并希望你以后按它写时，请主动调用本工具，不要只口头确认；调用前先阅读并分析样例。",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "该风格的简短名称，例如「技术文档风格」「学术论文风格」或 'academic-paper style'。",
        },
        profile: {
          type: "object",
          additionalProperties: true,
          description:
            "从样例中提取的结构化风格特征，适用于任意文体（实验报告、思想汇报、学术论文、公文、邮件、文案等）。请尽量覆盖以下维度，不适用的维度写「无」；每项可为对象或字符串，务必给出具体、可操作的特征，避免空泛；也可补充自定义维度（additionalProperties 允许）：",
          properties: {
            summary: { type: "string", description: "一两句话概括整体语气与文风。" },
            text_style: {
              description:
                "文本风格特征：语气语调、句式长短与结构、用词与词汇偏好、人称与代词、标点习惯、修辞手法、段落节奏、惯用表达等。",
            },
            illustrations: {
              description:
                "插图/配图特征：图片如何描述、图注写法与编号、图片放置位置、正文中如何引用图（如「见图 1」）。",
            },
            numbering: {
              description:
                "编写序号特征：章节/标题编号方式（如 1.、1.1、一、（一）、罗马数字）、列表符号与有序列表格式、层级缩进。",
            },
            tables: {
              description:
                "表格特征：表格结构、表头样式、表注与编号、边框与对齐（如三线表：顶线/表头下线/底线粗细）、首列/表体约定、何时用表格。",
            },
            fonts: {
              description:
                "字体特征（务必精确到字体名与字号）：中文/西文字体族（如宋体、微软雅黑、华文行楷、隶书）、各层级字号（标题/正文/代码/表注）、加粗/斜体/下划线、颜色、封面特殊字体与下划线、标题与正文字体差异。",
            },
            formatting: {
              description:
                "格式与版式特征：标题层级、段落缩进与行距、对齐方式、页边距、空行、强调方式（加粗/斜体/下划线）、代码块与引用块、表格三线表/边框、表注与图注编号与字号对齐、日期数字单位格式。",
            },
            rules: {
              type: "array",
              items: { type: "string" },
              description: "必须遵守的显式写作规则，每条一项。",
            },
            examples: { description: "可选：能体现该风格的简短示例片段（措辞或排版）。" },
          },
        },
        name: {
          type: "string",
          description: '用于存储/切换该档案的稳定键名；缺省为 "default"。可保存多套风格并用 activate_writing_style 切换。',
        },
        folder: {
          type: "string",
          description: "可选：在 Writing-Style 下为这套风格创建的自定义子文件夹名（如「实验报告」「学术论文」）；缺省用 name。每套风格各自一个子文件夹。",
        },
        file_path: {
          type: "string",
          description: "可选：额外把完整风格档案再导出到指定路径（相对或绝对）。默认始终保存到插件的 Writing-Style 文件夹。",
        },
      },
      required: ["title", "profile"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const key = optionalString(args && args.name) || "default";
      const title = optionalString(args && args.title) || key;
      const profile =
        args && args.profile && typeof args.profile === "object" ? args.profile : args && args.profile ? { raw: args.profile } : {};
      const updatedAt = new Date().toISOString();
      const record = { title, profile, updatedAt };

      const { store, dir, path: storePath } = openStore(exec);
      store.profiles[key] = record;
      store.activeName = key;
      let persisted = false;
      let storeDiag = "ok";
      try {
        writeStore(storePath, store);
        persisted = true;
      } catch (err) {
        storeDiag = "error:" + (err && err.message ? err.message : String(err));
      }
      active.current = { name: key, title, profile, updatedAt };

      // Each style gets its own customizable subfolder under Writing-Style.
      const folderName = sanitizeSegment(optionalString(args && args.folder) || key);
      const styleFile = join(dir, folderName, sanitizeSegment(key) + ".json");
      let filePath = null;
      try {
        writeStore(styleFile, { name: key, title, profile, updatedAt });
        filePath = styleFile;
      } catch (err) {
        filePath = "ERROR: " + (err && err.message ? err.message : String(err));
      }

      // Optional extra exports: explicit path, or legacy workspace file when autoWriteJson.
      const wantPath = optionalString(args && args.file_path) || (autoWriteJson ? jsonFileName : undefined);
      let extraPath = null;
      if (wantPath) {
        try {
          extraPath = await writeJsonFile(wantPath, { name: key, title, profile, updatedAt });
        } catch (err) {
          extraPath = "ERROR: " + (err && err.message ? err.message : String(err));
        }
      }

      const sections = typeof profile === "object" && !Array.isArray(profile) ? Object.keys(profile) : [];
      return {
        ok: true,
        message: `已保存并激活写作风格「${title}」（键名 ${key}）。${persisted ? "已保存到 " + filePath : "持久化失败：" + storeDiag}`,
        data: { name: key, folder: folderName, title, profile, sections, updatedAt, filePath, extraPath, persisted, storePath, storage: storeDiag },
      };
    },
  });

  // ---- show_writing_style ----
  ctx.tools.register({
    name: "show_writing_style",
    description: "查看当前激活的写作风格档案（即正在被应用到所有生成内容上的风格）。",
    parameters: { type: "object", properties: {} },
    output: OUTPUT,
    execute(args, exec) {
      const { store, path: storePath } = openStore(exec);
      const rec = store.activeName ? store.profiles[store.activeName] : undefined;
      const a =
        rec && typeof rec === "object"
          ? { name: store.activeName, title: rec.title, profile: rec.profile, updatedAt: rec.updatedAt }
          : null;
      active.current = a;
      if (!a) return { ok: true, message: "当前没有激活的写作风格。", data: { active: null, storePath, storage: "ok" } };
      return { ok: true, message: `当前风格：${a.title}`, data: { active: a, storePath, storage: "ok" } };
    },
  });

  // ---- list_writing_styles ----
  ctx.tools.register({
    name: "list_writing_styles",
    description: "列出所有已保存的写作风格档案。",
    parameters: { type: "object", properties: {} },
    output: OUTPUT,
    execute(args, exec) {
      const { store, path: storePath } = openStore(exec);
      const profiles = Object.entries(store.profiles)
        .filter(([, rec]) => rec && typeof rec === "object")
        .map(([k, rec]) => ({ name: k, title: rec.title, updatedAt: rec.updatedAt }));
      return {
        ok: true,
        message: `共 ${profiles.length} 个风格档案。`,
        data: { profiles, activeName: store.activeName, storePath, storage: "ok" },
      };
    },
  });

  // ---- activate_writing_style ----
  ctx.tools.register({
    name: "activate_writing_style",
    description: "切换激活的写作风格档案。切换后，后续写作将遵循所选风格。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要激活的风格档案键名（可用 list_writing_styles 查看）。" },
      },
      required: ["name"],
    },
    output: OUTPUT,
    execute(args, exec) {
      const { store, path: storePath } = openStore(exec);
      const key = optionalString(args && args.name);
      if (!key) return { ok: false, message: "请提供要激活的风格档案键名 name（可用 list_writing_styles 查看）。" };
      const rec = store.profiles[key];
      if (!rec || typeof rec !== "object") {
        return { ok: false, message: `未找到风格档案 "${key}"。可用 list_writing_styles 查看。` };
      }
      store.activeName = key;
      let persisted = false;
      try {
        writeStore(storePath, store);
        persisted = true;
      } catch {}
      active.current = { name: key, title: rec.title, profile: rec.profile, updatedAt: rec.updatedAt };
      return {
        ok: true,
        message: `已激活风格「${rec.title}」。${persisted ? "" : "（持久化失败）"}`,
        data: { active: { name: key, title: rec.title, updatedAt: rec.updatedAt }, storePath, storage: persisted ? "ok" : "error" },
      };
    },
  });

  // ---- clear_writing_style ----
  ctx.tools.register({
    name: "clear_writing_style",
    description: "删除一个写作风格档案；若未指定 name 则删除当前激活的档案。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要删除的档案键名；缺省删除当前激活的档案。" },
      },
    },
    output: OUTPUT,
    execute(args, exec) {
      const { store, path: storePath } = openStore(exec);
      const target = optionalString(args && args.name) || store.activeName;
      if (!target) return { ok: true, message: "没有可删除的风格档案。", data: { storePath, storage: "ok" } };
      const existed = !!store.profiles[target];
      if (existed) delete store.profiles[target];
      if (store.activeName === target) {
        store.activeName = null;
        active.current = null;
      }
      let persisted = false;
      try {
        writeStore(storePath, store);
        persisted = true;
      } catch {}
      return {
        ok: true,
        message: existed ? `已删除风格档案 "${target}"。${persisted ? "" : "（持久化失败）"}` : `未找到风格档案 "${target}"。`,
        data: { removed: target, existed, activeName: store.activeName, storePath, storage: persisted ? "ok" : "error" },
      };
    },
  });

  // ---- /writing-style slash command ----
  const commands = typeof ctx.get === "function" ? ctx.get("commands") : undefined;
  if (commands && typeof commands.register === "function") {
    // /writing-style <content>: hand the content to the model; it learns the
    // style from the conversation and writes in it. No management subcommands.
    const styleHandler = async (invocation) => {
      const raw = String(invocation.rawInput || "").trim();
      const attachments = invocation.attachments || [];
      if (!raw && attachments.length === 0) {
        return { kind: "success", text: "把要学/要写的内容跟在 /writing-style 后面即可。" };
      }
      invocation.agent.followup({
        id: randomUUID(),
        role: "user",
        content: [...attachments, ...(raw ? [{ type: "text", text: raw }] : [])],
        source: { kind: "user" },
      });
      return { kind: "success" };
    };
    const styleMeta = {
      description: "写作风格：把 /writing-style 后面的内容交给模型，自动学习风格并按它写作",
      input: { hint: "要学/要写的内容（可附文档）", attachments: true },
      handler: styleHandler,
    };
    ctx.effect(() => commands.register({ name: "writing-style", ...styleMeta }));
  }
}
