import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface SkillDocument extends SkillSummary {
  readonly instructions: string;
  readonly directory: string;
}

interface SkillEntry {
  readonly summary: SkillSummary;
  readonly file: string;
}

/** Discovers Agent Skills packages without running any files in them. */
export class SkillCatalog {
  private constructor(private readonly entries: ReadonlyMap<string, SkillEntry>) {}

  static async discover(root: string): Promise<SkillCatalog> {
    const entries = new Map<string, SkillEntry>();

    async function visit(directory: string): Promise<void> {
      const children = await readdir(directory, { withFileTypes: true });
      const manifest = children.find((child) => child.isFile() && child.name === "SKILL.md");

      if (manifest) {
        const file = path.join(directory, manifest.name);
        const { summary } = parseSkill(await readFile(file, "utf8"), file);
        if (entries.has(summary.name)) {
          throw new Error(`Duplicate skill name: ${summary.name}`);
        }
        entries.set(summary.name, { summary, file });
      }

      for (const child of children) {
        if (child.isDirectory() && !child.name.startsWith(".")) {
          await visit(path.join(directory, child.name));
        }
      }
    }

    await visit(root);
    return new SkillCatalog(entries);
  }

  list(): readonly SkillSummary[] {
    return [...this.entries.values()].map((entry) => entry.summary);
  }

  /** Full instructions are read only when a selected skill is opened. */
  async get(name: string): Promise<SkillDocument | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const { summary, instructions } = parseSkill(await readFile(entry.file, "utf8"), entry.file);
    if (summary.name !== name) {
      throw new Error(`Skill name changed after discovery: ${entry.file}`);
    }
    return { ...summary, instructions, directory: path.dirname(entry.file) };
  }
}

function parseSkill(source: string, file: string): {
  summary: SkillSummary;
  instructions: string;
} {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error(`Missing YAML frontmatter in ${file}`);

  const fields = new Map<string, string>();
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):(?:\s*(.*))?$/.exec(lines[index]);
    if (!field) continue;
    const [, key, rawValue = ""] = field;
    if (fields.has(key)) throw new Error(`Duplicate ${key} in ${file}`);
    if (rawValue === "|" || rawValue === ">" || rawValue === "|-" || rawValue === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1])) {
        block.push(lines[++index].trim());
      }
      fields.set(key, rawValue.startsWith(">") ? block.join(" ") : block.join("\n"));
    } else {
      fields.set(key, parseScalar(rawValue.trim(), file));
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) throw new Error(`Skill needs name and description: ${file}`);
  if (name !== path.basename(path.dirname(file))) {
    throw new Error(`Skill name must match its directory: ${file}`);
  }
  return {
    summary: { name, description },
    instructions: normalized.slice(match[0].length).trim(),
  };
}

function parseScalar(value: string, file: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new Error(`Invalid quoted frontmatter value in ${file}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`Invalid quoted frontmatter value in ${file}`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "");
}
