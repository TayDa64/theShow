import { generateGrokClip } from "./mcp/grokVideo.js";
const F = "/home/box/.theshow/media/board-a175e37274ff6439.jpg";
const L = "/home/box/.theshow/media/board-498c58e7a5a8895d.jpg";
const P = "Close on his hands pushing a glowing wireframe building into place above the desk.";
const base = { prompt: P, durationSeconds: 6, aspectRatio: "16:9", resolution: "480p" };
async function run(name: string, extra: any, n = 4) {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const r: any = await generateGrokClip({ ...base, ...extra }, { outputDir: "/tmp", waitForCompletion: true, timeoutSeconds: 240 });
    if (r.status === "completed") ok++;
  }
  console.log(`${name.padEnd(28)} ${ok}/${n} completed`);
}
await run("last_frame only", { lastFrameUrl: L });
await run("bookend (first+last)", { firstFrameUrl: F, lastFrameUrl: L });
await run("first_frame only", { firstFrameUrl: F });
