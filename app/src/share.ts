export const square = (p: number) => (p >= 100 ? "🟩" : p >= 50 ? "🟨" : "⬜");
/** `reads`: second-question score ("What did the pro do?"), left out when unknown (days played before it existed). */
export const shareText = (day: number, points: number[], reads: { right: number; of: number } | null = null) =>
  `⚽ Playmaker #${day} · ${points.reduce((a, b) => a + b, 0)}/${points.length * 100}${reads ? ` · 👁 ${reads.right}/${reads.of}` : ""}\n${points.map(square).join("")}`;
