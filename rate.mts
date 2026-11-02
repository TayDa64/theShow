import { generateGrokClip } from "./mcp/grokVideo.js";
const F = "/home/box/.theshow/media/board-a175e37274ff6439.jpg";
const L = "/home/box/.theshow/media/board-498c58e7a5a8895d.jpg";
const P = "Close on his hands pushing a glowing wireframe building into place above the desk.";
let ok = 0, bad = 0;
for (let i = 0; i < 6; i++) {
  const r: any = await generateGrokClip({ prompt: P, durationSeconds: 6, aspectRatio: "16:9", resolution: "480p", firstFrameUrl: F, lastFrameUrl: L }, { outputDir: "/tmp", waitForCompletion: true, timeoutSeconds: 240 });
  if (r.status === "completed") ok++; else { bad++; console.log("  fail", r.code ?? "", (r.detail ?? "").slice(0,120)); }
}
console.log(`bookend with last_frame: ${ok} completed, ${bad} failed`);
