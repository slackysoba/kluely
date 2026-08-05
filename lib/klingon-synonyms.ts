// Concept → near-synonym bridge for grounding lookup.
//
// Morphology (lib/english-normalize) reclaims inflected and derived forms, but
// it cannot bridge *lexical* gaps: high-frequency English abstractions that
// simply never appear as a word in any Klingon gloss ("problem", "team",
// "build", "result", "idea"). Klingon usually *does* have a serviceable root —
// it's just filed under a different English word ("problem" → Qatlh is glossed
// "difficult"; "team" → ghom is glossed "group"). This map supplies those
// English→English hops so the concept can reach the root.
//
// Deliberately general-purpose (everyday abstractions, qualities, actions),
// not tuned to any one topic. Each hop is a *meaning-preserving* near-synonym,
// hypernym, or concrete stand-in — the same substitution philosophy the
// simplify step already applies, just made reliable instead of left to chance.
// Entries whose targets happen not to exist in the lexicon are harmless: a
// candidate that matches no index key costs nothing.

const SYNONYMS: Record<string, string[]> = {
  // --- abstractions → concrete/near-synonym ---
  problem: ["difficulty", "trouble", "obstacle", "mistake", "challenge"],
  issue: ["problem", "difficulty", "matter", "trouble"],
  challenge: ["difficulty", "test", "obstacle", "dare"],
  obstacle: ["difficulty", "barrier", "problem"],
  result: ["outcome", "effect", "consequence", "end", "achievement"],
  outcome: ["result", "effect", "end"],
  effect: ["result", "consequence", "change"],
  consequence: ["result", "effect", "end"],
  solution: ["answer", "fix"],
  reason: ["cause", "purpose"],
  cause: ["reason", "source"],
  meaning: ["sense", "purpose"],

  // --- groups / people ---
  team: ["group", "crew", "band", "company", "unit"],
  group: ["band", "crew", "gathering"],
  company: ["group", "crew", "band", "business"],
  organization: ["group", "system"],
  crowd: ["group", "gathering"],
  member: ["person", "one"],
  customer: ["buyer", "client"],
  client: ["customer", "buyer"],
  partner: ["friend", "ally", "companion"],
  colleague: ["friend", "companion", "worker"],
  stranger: ["enemy", "outsider"],

  // --- actions ---
  build: ["make", "create", "construct", "form", "assemble"],
  create: ["make", "build", "form"],
  develop: ["grow", "build", "create", "improve"],
  improve: ["better", "advance", "grow"],
  manage: ["lead", "control", "direct", "handle", "rule"],
  lead: ["guide", "direct", "command", "rule"],
  handle: ["manage", "hold", "control"],
  support: ["help", "aid", "hold", "defend"],
  help: ["aid", "assist", "support", "serve"],
  achieve: ["accomplish", "win", "reach", "gain"],
  overcome: ["conquer", "defeat", "beat"],
  solve: ["fix", "answer", "resolve"],
  fix: ["repair", "mend", "solve"],
  focus: ["concentrate", "aim"],
  decide: ["choose", "determine"],
  communicate: ["speak", "talk", "tell"],
  collaborate: ["cooperate", "work", "help"],
  cooperate: ["work", "help", "join"],
  discuss: ["talk", "speak"],
  explain: ["tell", "describe", "teach"],

  // --- work / effort ---
  job: ["work", "task", "duty", "mission"],
  task: ["work", "duty", "mission"],
  effort: ["work", "toil"],
  goal: ["purpose", "aim", "target", "end"],
  purpose: ["goal", "aim", "reason"],
  plan: ["strategy", "scheme", "design"],
  strategy: ["plan", "scheme", "method"],
  method: ["way", "process", "procedure"],
  process: ["procedure", "method", "way"],
  project: ["work", "task", "mission"],
  duty: ["task", "work", "responsibility"],
  responsibility: ["duty", "task", "burden"],
  opportunity: ["chance"],
  success: ["victory", "achievement", "triumph"],
  failure: ["defeat", "loss", "mistake"],
  loss: ["defeat", "lose", "death"],
  progress: ["advance", "growth"],
  growth: ["increase", "development"],
  experience: ["knowledge", "skill", "event"],
  skill: ["ability", "expertise", "talent"],
  knowledge: ["wisdom", "learning", "understanding"],
  education: ["learning", "teaching", "knowledge"],
  feedback: ["answer", "response", "comment"],
  idea: ["thought", "plan", "notion"],
  quality: ["excellence", "worth", "value"],
  priority: ["importance", "first"],

  // --- qualities ---
  smart: ["clever", "intelligent", "wise"],
  intelligent: ["clever", "wise", "smart"],
  clever: ["intelligent", "wise", "skilled"],
  important: ["great", "valuable", "significant"],
  difficult: ["hard", "tough"],
  hard: ["difficult", "tough"],
  easy: ["simple"],
  fast: ["quick", "rapid", "swift"],
  quick: ["fast", "rapid", "swift"],
  strong: ["powerful", "mighty"],
  powerful: ["strong", "mighty"],
  brave: ["courageous", "bold", "fearless", "heroic"],
  happy: ["glad", "joyful", "pleased"],
  sad: ["unhappy", "sorrowful"],
  angry: ["mad", "furious"],
  afraid: ["scared", "fearful"],
  excellent: ["great", "superb", "superior"],
  effective: ["successful", "powerful"],
  efficient: ["fast", "quick"],
  reliable: ["dependable", "steady", "trustworthy"],
  mighty: ["strong", "powerful", "great"],
  worthy: ["valuable", "good", "honorable"],
  glorious: ["great", "honored", "magnificent"],

  // --- concepts / things ---
  power: ["strength", "force", "energy"],
  energy: ["power", "force", "strength"],
  strength: ["power", "force"],
  courage: ["bravery", "valor"],
  fear: ["terror", "dread"],
  freedom: ["liberty"],
  peace: ["calm", "quiet"],
  war: ["battle", "conflict", "fight"],
  conflict: ["battle", "fight", "war"],
  money: ["wealth", "gold", "riches"],
  wealth: ["riches", "money"],
  time: ["moment", "period"],
  way: ["path", "road", "method", "route"],
  thing: ["object", "item"],
  place: ["location", "area", "spot"],
  people: ["person", "beings"],
  world: ["planet", "earth"],
  future: ["tomorrow"],
  past: ["yesterday"],
  danger: ["threat", "peril"],
  benefit: ["gain", "advantage", "good"],
  value: ["worth", "importance"],
  trust: ["faith", "confidence"],
  respect: ["honor", "esteem"],
  pride: ["honor", "dignity"],
  passion: ["desire", "love", "eagerness"],
  emotion: ["feeling"],
};

/**
 * Near-synonym / hypernym English concepts for a given English word — the
 * meaning-preserving hops that let it reach a Klingon root filed under a
 * different gloss word. Empty when we have no bridge for the word.
 */
export function conceptSynonyms(word: string): string[] {
  return SYNONYMS[word.toLowerCase().trim()] ?? [];
}
