import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "__tests__", "fixtures", "stall-fetch.mjs");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tclQuote(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")}"`;
}

function spawnInPty(home) {
  const nodeArgs = [
    process.execPath,
    "--import",
    fixture,
    path.join(root, "tui.mjs"),
    "--no-splash",
  ];

  // macOS `script` requires its own stdin to be a terminal, so use the built-in
  // Expect runtime there. util-linux `script` accepts piped input on Linux.
  if (process.platform === "darwin") {
    const expectScript = `
      log_user 1
      set timeout 2
      spawn -noecho ${nodeArgs.map(tclQuote).join(" ")}
      expect {
        -re {not signed in} { send -- "\\033\\[D" }
        timeout { exit 123 }
      }
      expect {
        -re {Live Watch} { send -- q }
        timeout { exit 124 }
      }
      expect {
        eof {
          catch wait result
          exit [lindex $result 3]
        }
        timeout { exit 125 }
      }
    `;
    return {
      child: spawn("expect", ["-c", expectScript], {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      sendNavigate: () => {},
      sendQuit: () => {},
    };
  }

  const command = nodeArgs.map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    child,
    sendNavigate: () => child.stdin.write("\x1b[D"),
    sendQuit: () => child.stdin.write("q"),
  };
}

test(
  "TUI accepts navigation and quit input while startup data is still loading",
  { skip: process.platform === "win32", timeout: 4_000 },
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "sigrank-tui-test-"));
    const { child, sendNavigate, sendQuit } = spawnInPty(home);
    let output = "";
    let sentNavigate = false;
    let sentQuit = false;

    const result = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!sentNavigate && output.includes("not signed in")) {
          sentNavigate = true;
          sendNavigate();
        }
        if (!sentQuit && output.includes("Live Watch")) {
          sentQuit = true;
          sendQuit();
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const { code, signal } = await result;
      assert.equal(sentNavigate, true, `Connect screen was never rendered:\n${output}`);
      assert.equal(sentQuit, true, `Watch navigation was not handled:\n${output}`);
      assert.equal(signal, null, `TUI was killed by ${signal}:\n${output}`);
      assert.equal(code, 0, `TUI exited with ${code}:\n${output}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
