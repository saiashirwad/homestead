import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface TempGitRepo {
  readonly dir: string
  readonly root: string
  readonly workspacesDir: string
  readonly registryFile: string
  readonly cleanup: () => void
}

export const createTempGitRepo = (): TempGitRepo => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "homestead-repo-fixture-")))
  const dir = path.join(root, path.basename(root))
  const workspacesDir = path.join(root, "workspaces")
  const registryFile = path.join(root, "state", "workspaces.json")
  fs.mkdirSync(dir)
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" })
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n")
  fs.writeFileSync(
    path.join(dir, "homestead.config.ts"),
    `export default { worktreeDir: ({ slug }: { slug: string }) => ${JSON.stringify(workspacesDir)} + "/" + slug }\n`,
  )
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" })

  return {
    dir,
    root,
    workspacesDir,
    registryFile,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

export interface TempSocket {
  readonly dir: string
  readonly path: string
  readonly cleanup: () => void
}

export const createTempSocket = (): TempSocket => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "homestead-sock-fixture-")))
  const sockPath = path.join(dir, "daemon.sock")
  return {
    dir,
    path: sockPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

export const createStaleSocketFile = (sockPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      `
        const net = require("node:net");
        const s = net.createServer();
        s.listen(${JSON.stringify(sockPath)}, () => {
          process.stdout.write("READY\\n");
          setInterval(() => {}, 10000);
        });
      `,
    ])

    let resolved = false

    child.stdout.on("data", (data) => {
      if (data.toString().includes("READY")) {
        child.kill("SIGKILL")
      }
    })

    child.on("exit", () => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    })

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })
  })
