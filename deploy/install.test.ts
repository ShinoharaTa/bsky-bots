import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
const USER = userInfo().username;
/** テストを走らせている node。PATH に依存させない。 */
const NODE = process.execPath;

const UNITS = [
  "bsky-bots-failure@.service",
  "bsky-jiho.service",
  "bsky-jiho.timer",
  "bsky-skyhigh.service",
  "bsky-skyhigh.timer",
  "bsky-skylog.service",
  "bsky-skylog.timer",
];
const SERVICES = UNITS.filter((u) => u.endsWith(".service"));

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** base の下に dist/main.js・dist/tools/notify-failure.js・.env を持つダミーの APP_DIR を作る。 */
function makeApp(base: string, { dist = true } = {}) {
  const root = mkdtempSync(join(base, "bsky-install-test-"));
  cleanups.push(root);
  const app = join(root, "app");
  mkdirSync(join(app, "dist", "tools"), { recursive: true });
  if (dist) {
    writeFileSync(join(app, "dist", "main.js"), "");
    writeFileSync(join(app, "dist", "tools", "notify-failure.js"), "");
  }
  writeFileSync(join(app, ".env"), "");
  chmodSync(join(app, ".env"), 0o600);
  const dest = join(root, "dest");
  mkdirSync(dest);
  return { app, dest };
}

function run(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

function common(app: string) {
  return ["--app-dir", app, "--user", USER, "--node", NODE];
}

describe("deploy/install.sh", () => {
  it("--dest に指定したパス・ユーザーで unit を書き、プレースホルダを残さない", () => {
    const { app, dest } = makeApp(tmpdir());
    const r = run([...common(app), "--dest", dest]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(dest).sort()).toEqual(UNITS);

    for (const name of UNITS) {
      expect(readFileSync(join(dest, name), "utf8")).not.toMatch(/@[A-Z_]+@/);
    }
    for (const name of SERVICES) {
      const unit = readFileSync(join(dest, name), "utf8");
      expect(unit).toContain(`User=${USER}`);
      expect(unit).toMatch(/^Group=\S+$/m);
      expect(unit).toContain(`WorkingDirectory=${app}\n`);
      expect(unit).toContain(`EnvironmentFile=${join(app, ".env")}\n`);
      expect(unit).toContain(`ExecStart=${NODE} dist/`);
    }
    const skyhigh = readFileSync(join(dest, "bsky-skyhigh.service"), "utf8");
    expect(skyhigh).toContain(`ExecStart=${NODE} dist/main.js skyhigh --live`);
    expect(skyhigh).toContain("OnFailure=bsky-bots-failure@%n.service");
    expect(skyhigh).toContain("TimeoutStartSec=1800");
    const failure = readFileSync(
      join(dest, "bsky-bots-failure@.service"),
      "utf8",
    );
    expect(failure).toContain("SupplementaryGroups=systemd-journal");
    expect(failure).toContain("Environment=BSKY_SYSTEMD_SCOPE=system");
  });

  it("ホーム外に置いたら ProtectHome=yes", () => {
    const { app, dest } = makeApp(tmpdir());
    if (/^\/(root|home|run\/user)(\/|$)/.test(app)) return;
    const r = run([...common(app), "--dest", dest]);
    expect(r.status, r.stderr).toBe(0);
    const unit = readFileSync(join(dest, "bsky-skyhigh.service"), "utf8");
    expect(unit).toContain("ProtectHome=yes\n");
  });

  it("/home・/root 配下に置いたら ProtectHome=read-only", () => {
    const home = homedir();
    if (!/^\/(root|home)(\/|$)/.test(home)) return;
    const { app, dest } = makeApp(home);
    const r = run([...common(app), "--dest", dest]);
    expect(r.status, r.stderr).toBe(0);
    for (const name of [
      "bsky-skyhigh.service",
      "bsky-skylog.service",
      "bsky-jiho.service",
    ]) {
      const unit = readFileSync(join(dest, name), "utf8");
      expect(unit).toContain("ProtectHome=read-only\n");
    }
  });

  it("--print は標準出力に出すだけで書き込まない", () => {
    const { app, dest } = makeApp(tmpdir());
    const r = run([...common(app), "--print"]);
    expect(r.status, r.stderr).toBe(0);
    for (const name of UNITS) expect(r.stdout).toContain(`### ${name}\n`);
    expect(r.stdout).toContain(`WorkingDirectory=${app}\n`);
    expect(r.stdout).toContain(`User=${USER}\n`);
    expect(r.stdout).not.toMatch(/@[A-Z_]+@/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("dist が無ければエラー終了する", () => {
    const { app, dest } = makeApp(tmpdir(), { dist: false });
    const r = run([...common(app), "--dest", dest]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("npm ci && npm run build");
    expect(readdirSync(dest)).toEqual([]);
  });

  it("env ファイルが無ければエラー終了する", () => {
    const { app, dest } = makeApp(tmpdir());
    rmSync(join(app, ".env"));
    const r = run([...common(app), "--dest", dest]);
    expect(r.status).not.toBe(0);
    expect(readdirSync(dest)).toEqual([]);
  });
});
