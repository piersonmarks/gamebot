import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryScope {
  gameId: string;
  gameVersion: string;
  worldId?: string;
}

export interface Episode {
  id: string;
  scope: MemoryScope;
  runId: string;
  recordedAt: string;
  summary: string;
  outcome?: string;
  sourceRefs: string[];
}

export interface Lesson {
  id: string;
  text: string;
  sourceEpisodeIds: string[];
}

export interface MemorySnapshot {
  id: string;
  scope: MemoryScope;
  version: number;
  createdAt: string;
  lessons: Lesson[];
}

export interface LessonProposal {
  text: string;
  sourceEpisodeIds: string[];
}

export type LessonValidator = (
  proposal: LessonProposal,
  sources: Episode[],
) => boolean | Promise<boolean>;

export type MemoryRetriever = (
  query: string,
  lessons: readonly Lesson[],
  limit: number,
) => Lesson[];

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export const lexicalRetriever: MemoryRetriever = (query, lessons, limit) => {
  const queryTerms = terms(query);
  return lessons
    .map((lesson, index) => ({
      lesson,
      index,
      score: [...terms(lesson.text)].filter((term) => queryTerms.has(term)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ lesson }) => lesson);
};

function assertScope(scope: MemoryScope): void {
  if (!scope.gameId?.trim() || !scope.gameVersion?.trim() || scope.worldId === "") {
    throw new Error("Memory scope requires a game ID and version, and a nonempty world ID when supplied");
  }
}

function scopeKey(scope: MemoryScope): string {
  assertScope(scope);
  return createHash("sha256")
    .update(JSON.stringify([scope.gameId, scope.gameVersion, scope.worldId ?? null]))
    .digest("hex");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** Local storage for episode evidence and validated, versioned knowledge. */
export class FileMemoryStore {
  constructor(
    private readonly directory: string,
    private readonly retriever: MemoryRetriever = lexicalRetriever,
  ) {}

  private scopeDirectory(scope: MemoryScope): string {
    return join(this.directory, "scopes", scopeKey(scope));
  }

  async recordEpisode(input: {
    scope: MemoryScope;
    runId: string;
    summary: string;
    outcome?: string;
    sourceRefs?: string[];
  }): Promise<Episode> {
    assertScope(input.scope);
    if (!input.runId.trim() || !input.summary.trim()) {
      throw new Error("An episode requires a run ID and summary");
    }
    const episode: Episode = {
      id: randomUUID(),
      scope: input.scope,
      runId: input.runId,
      recordedAt: new Date().toISOString(),
      summary: input.summary,
      outcome: input.outcome,
      sourceRefs: input.sourceRefs ?? [],
    };
    const directory = join(this.scopeDirectory(input.scope), "episodes");
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, `${episode.id}.json`), episode);
    return episode;
  }

  async listEpisodes(scope: MemoryScope): Promise<Episode[]> {
    const directory = join(this.scopeDirectory(scope), "episodes");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const episodes = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJson<Episode>(join(directory, name))),
    );
    return episodes.filter((episode): episode is Episode => episode !== undefined)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  async latestSnapshot(scope: MemoryScope): Promise<MemorySnapshot | undefined> {
    const directory = this.scopeDirectory(scope);
    const latest = await readJson<{ id: string }>(join(directory, "latest.json"));
    return latest ? this.snapshot(scope, latest.id) : undefined;
  }

  async snapshot(scope: MemoryScope, id: string): Promise<MemorySnapshot | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid snapshot ID");
    return readJson<MemorySnapshot>(join(this.scopeDirectory(scope), "snapshots", `${id}.json`));
  }

  async consolidate(
    scope: MemoryScope,
    proposals: LessonProposal[],
    validate: LessonValidator,
  ): Promise<MemorySnapshot> {
    const episodes = await this.listEpisodes(scope);
    const byId = new Map(episodes.map((episode) => [episode.id, episode]));
    const lessons: Lesson[] = [];
    for (const proposal of proposals) {
      if (!proposal.text.trim() || proposal.sourceEpisodeIds.length === 0) {
        throw new Error("A lesson requires text and episode evidence");
      }
      const sources = proposal.sourceEpisodeIds.map((id) => byId.get(id));
      if (sources.some((episode) => episode === undefined)) {
        throw new Error("A lesson cites an episode outside this memory scope");
      }
      if (!(await validate(proposal, sources as Episode[]))) {
        throw new Error("Lesson validation failed; the snapshot was not changed");
      }
      lessons.push({ id: randomUUID(), text: proposal.text, sourceEpisodeIds: [...proposal.sourceEpisodeIds] });
    }

    const previous = await this.latestSnapshot(scope);
    const result: MemorySnapshot = {
      id: randomUUID(),
      scope,
      version: (previous?.version ?? 0) + 1,
      createdAt: new Date().toISOString(),
      lessons: [...(previous?.lessons ?? []), ...lessons],
    };
    const directory = this.scopeDirectory(scope);
    await mkdir(join(directory, "snapshots"), { recursive: true });
    await writeJson(join(directory, "snapshots", `${result.id}.json`), result);
    await writeJson(join(directory, "latest.json"), { id: result.id });
    return result;
  }

  async pinSnapshot(runId: string, scope: MemoryScope, snapshotId?: string): Promise<MemorySnapshot> {
    if (!runId.trim()) throw new Error("A pin requires a run ID");
    const directory = join(this.scopeDirectory(scope), "pins");
    const runKey = createHash("sha256").update(runId).digest("hex");
    const pinPath = join(directory, `${runKey}.json`);
    const existing = await readJson<{ snapshotId: string }>(pinPath);
    if (existing) {
      if (snapshotId && snapshotId !== existing.snapshotId) {
        throw new Error("A run's memory snapshot is already pinned");
      }
      const pinned = await this.snapshot(scope, existing.snapshotId);
      if (!pinned) throw new Error("Pinned memory snapshot is missing");
      return pinned;
    }
    const selected = snapshotId
      ? await this.snapshot(scope, snapshotId)
      : await this.latestSnapshot(scope);
    if (!selected) throw new Error("Cannot pin a missing memory snapshot");
    await mkdir(directory, { recursive: true });
    await writeJson(pinPath, { runId, snapshotId: selected.id });
    return selected;
  }

  async retrieve(input: {
    scope: MemoryScope;
    query: string;
    runId?: string;
    limit?: number;
  }): Promise<{ snapshot?: MemorySnapshot; lessons: Lesson[] }> {
    let selected: MemorySnapshot | undefined;
    if (input.runId) {
      const runKey = createHash("sha256").update(input.runId).digest("hex");
      const pin = await readJson<{ snapshotId: string }>(
        join(this.scopeDirectory(input.scope), "pins", `${runKey}.json`),
      );
      if (pin) {
        selected = await this.snapshot(input.scope, pin.snapshotId);
        if (!selected) throw new Error("Pinned memory snapshot is missing");
      }
    }
    selected ??= await this.latestSnapshot(input.scope);
    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Retrieval limit must be a nonnegative integer");
    return {
      snapshot: selected,
      lessons: selected ? this.retriever(input.query, selected.lessons, limit) : [],
    };
  }
}
