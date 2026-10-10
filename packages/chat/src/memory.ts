import { questionTokens, suspicious, topicWords } from "./grounding.js";
export interface Memory {
  questions: string[];
  topic: string | null;
}
export function summarizeQuestions(questions: string[]): Memory {
  const bounded: string[] = [];
  let tokens = 0;
  for (const q of [...questions].reverse()) {
    if (suspicious(q)) continue;
    const cost = questionTokens(q);
    if (cost > 160 || tokens + cost > 400) continue;
    bounded.unshift(q);
    tokens += cost;
    if (bounded.length >= 6) break;
  }
  return { questions: bounded, topic: bounded.at(-1) ?? null };
}
export function rewriteQuery(question: string, memory: Memory) {
  const trimmed = question.trim();
  const followUp =
    /^(?:and\b|what about\b|how about\b|what if\b|also\b|why\b|how much\b|does (?:it|that|this)\b|is (?:it|that|this)\b|can (?:it|that|this)\b|explain (?:it|that|this)\b)|\b(?:its|that limit|this limit|that benefit|the other one|same condition)\b/i.test(
      trimmed,
    );
  if (!followUp || !memory.topic) return { query: trimmed, usedHistory: false };
  // A follow-up naming a new subject does not carry old policy facts or answer text.
  const substantive = /^(?:and\s+)?(?:what|how) about\s+(.+)/i.exec(
    trimmed,
  )?.[1];
  const lastTopic = memory.topic.split("\nFollow-up question:").at(-1)!;
  // An explicit subject replaces the older topic for subsequent anaphoric turns.
  const topic = topicWords(lastTopic).length ? lastTopic : memory.topic;
  const query =
    substantive && !/^(?:it|its|that|this|the other one)\b/i.test(substantive)
      ? `${substantive.replace(/[?]+$/, "?")}`
      : `Previous question: ${topic}\nFollow-up question: ${trimmed}`;
  return { query, usedHistory: true };
}
