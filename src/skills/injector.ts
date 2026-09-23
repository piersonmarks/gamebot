import { SkillCatalog, type SkillSummary } from "./catalog.js";

/** Selection is replaceable and has no authority to execute a skill. */
export interface SkillInjector<Context> {
  select(context: Context, available: readonly SkillSummary[]):
    | readonly string[]
    | Promise<readonly string[]>;
}

export async function selectSkillSummaries<Context>(
  catalog: SkillCatalog,
  injector: SkillInjector<Context>,
  context: Context,
): Promise<readonly SkillSummary[]> {
  const available = catalog.list();
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const selected = await injector.select(context, available);
  const result: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const name of selected) {
    if (seen.has(name)) continue;
    const skill = byName.get(name);
    if (!skill) throw new Error(`Injector selected unknown skill: ${name}`);
    result.push(skill);
    seen.add(name);
  }
  return result;
}
