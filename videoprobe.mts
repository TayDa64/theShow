import { generateGrokClip } from "./mcp/grokVideo.js";
const N1 = "/home/box/.theshow/media/board-64978a0feba329ee.jpg";
const N2 = "/home/box/.theshow/media/board-a175e37274ff6439.jpg";
const P = "A man stands at a desk.";
const base = { prompt: P, durationSeconds: 4, aspectRatio: "16:9", resolution: "480p" };
for (let i = 1; i <= 3; i++) {
  const r: any = await generateGrokClip({ ...base, lastFrameUrl: N2 }, { outputDir: "/home/box/.theshow/media", waitForCompletion: true, timeoutSeconds: 300 });
  console.log(`lastonly try${i}`, "->", r.status, JSON.stringify(r.error ?? "").slice(0,160), r.localPath ?? "");
}
