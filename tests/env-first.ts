/**
 * Runs before tests/setup.ts.
 *
 * setup.ts imports the auth store, which imports mcp/media.ts. That module
 * captures JOBS_DIR and OUTPUT_DIR at import. The capture has to see the temp
 * directories, or in-process tests write into the real ~/.theshow.
 */
import fs from "fs";
import os from "os";
import path from "path";

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "theshow-suite-"));
process.env.THESHOW_OUTPUT_DIR = path.join(suiteRoot, "media");
process.env.THESHOW_JOBS_DIR = path.join(suiteRoot, "jobs");
process.env.THESHOW_CHARACTERS_DIR = path.join(suiteRoot, "characters");
process.env.THESHOW_CONSISTENCY_DIR = path.join(suiteRoot, "consistency");
fs.mkdirSync(process.env.THESHOW_OUTPUT_DIR, { recursive: true });
fs.mkdirSync(process.env.THESHOW_JOBS_DIR, { recursive: true });
fs.mkdirSync(process.env.THESHOW_CHARACTERS_DIR, { recursive: true });
fs.mkdirSync(process.env.THESHOW_CONSISTENCY_DIR, { recursive: true });
process.env.GROK_AUTH_FILE = "/nonexistent/theshow-test-auth.json";
process.env.THESHOW_FORBID_HOME_AUTH = "1";
delete process.env.XAI_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.GEMINI_API_KEY;
