export const square = (p: number) => (p >= 100 ? "🟩" : p >= 50 ? "🟨" : "⬜");
export const shareText = (day: number, points: number[]) =>
  `⚽ Playmaker #${day} · ${points.reduce((a, b) => a + b, 0)}/${points.length * 100}\n${points.map(square).join("")}`;
