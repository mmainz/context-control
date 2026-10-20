import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { describe, expect, it } from "vitest";

const repositoryRoot = import.meta.dirname;
const piCli =
  process.env.CONTEXT_CONTROL_PI_CLI ??
  join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const probeProvider = join(repositoryRoot, "integration-fixtures", "probe-provider.ts");
const piTimeoutMs = 30_000;

function runPi(
  cwd: string,
  agentDir: string,
  args: string[],
  environment: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [piCli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: piTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      ...environment,
    },
  });
}

function failureDetails(result: SpawnSyncReturns<string>): string {
  return JSON.stringify(
    {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  );
}

function expectSuccessfulPiRun(result: SpawnSyncReturns<string>): void {
  const details = failureDetails(result);
  expect(result.error, details).toBeUndefined();
  expect(result.status, details).toBe(0);
  expect(result.stderr, details).not.toContain("Failed to load extension");
  expect(result.stderr, details).not.toContain("Extension error (");
}

function commonArguments(): string[] {
  return [
    "--offline",
    "--approve",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
}

async function writeSkill(skillRoot: string, name: string, marker: string): Promise<string> {
  const directory = join(skillRoot, name);
  const path = join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: ${marker}\n---\n\n# ${name}\n\nIntegration-test skill.\n`,
    "utf8",
  );
  return path;
}

async function writeSkillConfig(
  agentDir: string,
  projectDir: string,
  skills: unknown,
): Promise<void> {
  const canonicalProject = await realpath(projectDir);
  const repositoryId = `path:${canonicalProject}`;
  const configKey = createHash("sha256").update(repositoryId).digest("hex").slice(0, 24);
  const configDir = join(agentDir, "context-control");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, `${configKey}.json`),
    `${JSON.stringify(
      {
        version: 2,
        repository: {
          id: repositoryId,
          label: canonicalProject,
        },
        skills,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("Pi CLI integration", () => {
  it(
    "starts a real Pi session with the extension",
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "context-control-startup-"));
      const projectDir = join(temporaryRoot, "project");
      const agentDir = join(temporaryRoot, "agent");
      await mkdir(projectDir, { recursive: true });

      try {
        const result = runPi(projectDir, agentDir, [
          ...commonArguments(),
          "--extension",
          repositoryRoot,
          "--print",
          "",
        ]);

        expectSuccessfulPiRun(result);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    piTimeoutMs + 5_000,
  );

  it(
    "treats a repository skill symlink as project-owned",
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "context-control-symlink-policy-"));
      const projectDir = join(temporaryRoot, "project");
      const agentDir = join(temporaryRoot, "agent");
      const targetRoot = join(temporaryRoot, "shared", "linked-skill");
      const skillRoot = join(projectDir, ".agents", "skills");
      const linkedSkillRoot = join(skillRoot, "linked-skill");
      const resultPath = join(temporaryRoot, "probe-result.json");
      const marker = "LINKED_SKILL_INTEGRATION_MARKER";
      await mkdir(projectDir, { recursive: true });

      try {
        await writeSkill(join(temporaryRoot, "shared"), "linked-skill", marker);
        await mkdir(skillRoot, { recursive: true });
        await symlink(targetRoot, linkedSkillRoot);
        await writeSkillConfig(agentDir, projectDir, { mode: "none" });

        const result = runPi(
          projectDir,
          agentDir,
          [
            ...commonArguments(),
            "--extension",
            repositoryRoot,
            "--extension",
            probeProvider,
            "--skill",
            linkedSkillRoot,
            "--provider",
            "context-control-probe",
            "--model",
            "probe-model",
            "--print",
            "run context-control symlink integration probe",
          ],
          {
            CONTEXT_CONTROL_PROBE_RESULT: resultPath,
            CONTEXT_CONTROL_ALLOWED_MARKER: "UNUSED_ALLOWED_SKILL_MARKER",
            CONTEXT_CONTROL_BLOCKED_MARKER: marker,
          },
        );

        expectSuccessfulPiRun(result);
        expect(result.stdout).toContain("probe-ok");

        const report = JSON.parse(await readFile(resultPath, "utf8")) as {
          blockedVisible: boolean;
          commandNames: string[];
        };
        expect(report.blockedVisible).toBe(false);
        expect(report.commandNames).toContain("skill:linked-skill");
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    piTimeoutMs + 5_000,
  );

  it.each(
    (["blocklist", "allowlist", "none"] as const).flatMap((mode) => [
      { mode, tools: "read,bash,edit,write" },
      { mode, tools: "bash" },
    ]),
  )(
    "applies $mode policy to provider context with tools=$tools while keeping skill commands",
    async ({ mode, tools }) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "context-control-policy-"));
      const projectDir = join(temporaryRoot, "project");
      const agentDir = join(temporaryRoot, "agent");
      const skillRoot = join(projectDir, ".pi", "skills");
      const resultPath = join(temporaryRoot, "probe-result.json");
      const allowedMarker = "ALLOWED_SKILL_INTEGRATION_MARKER";
      const blockedMarker = "BLOCKED_SKILL_INTEGRATION_MARKER";
      await mkdir(projectDir, { recursive: true });

      try {
        const allowedSkillPath = await writeSkill(skillRoot, "allowed", allowedMarker);
        const blockedSkillPath = await writeSkill(skillRoot, "blocked", blockedMarker);
        const selected = mode === "allowlist" ? "allowed" : "blocked";
        await writeSkillConfig(agentDir, projectDir, {
          mode,
          ...(mode === "none"
            ? {}
            : {
                refs: [
                  {
                    id: `repo:.pi/skills/${selected}/SKILL.md`,
                    path: selected === "allowed" ? allowedSkillPath : blockedSkillPath,
                    label: selected,
                    group: "temporary",
                  },
                ],
              }),
        });

        const args = [
          ...commonArguments(),
          "--tools",
          tools,
          "--extension",
          probeProvider,
          "--skill",
          skillRoot,
          "--provider",
          "context-control-probe",
          "--model",
          "probe-model",
          "--print",
          "run context-control integration probe",
        ];
        const environment = {
          CONTEXT_CONTROL_PROBE_RESULT: resultPath,
          CONTEXT_CONTROL_ALLOWED_MARKER: allowedMarker,
          CONTEXT_CONTROL_BLOCKED_MARKER: blockedMarker,
        };
        const control = runPi(projectDir, agentDir, args, environment);
        expectSuccessfulPiRun(control);
        const controlReport = JSON.parse(await readFile(resultPath, "utf8")) as {
          allowedVisible: boolean;
          blockedVisible: boolean;
        };
        // Older Pi omits all skills with bash alone; newer Pi advertises both readers.
        expect(controlReport.blockedVisible).toBe(controlReport.allowedVisible);
        if (tools.includes("read")) expect(controlReport.allowedVisible).toBe(true);
        await rm(resultPath);

        const result = runPi(
          projectDir,
          agentDir,
          ["--extension", repositoryRoot, ...args],
          environment,
        );
        expectSuccessfulPiRun(result);
        expect(result.stdout).toContain("probe-ok");

        const report = JSON.parse(await readFile(resultPath, "utf8")) as {
          allowedVisible: boolean;
          blockedVisible: boolean;
          blockedNameVisible: boolean;
          blockedPathVisible: boolean;
          allowedCommandRegistered: boolean;
          blockedCommandRegistered: boolean;
        };
        expect(report).toMatchObject({
          allowedVisible: mode !== "none" && controlReport.allowedVisible,
          blockedVisible: false,
          blockedNameVisible: false,
          blockedPathVisible: false,
          allowedCommandRegistered: true,
          blockedCommandRegistered: true,
        });
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    piTimeoutMs + 5_000,
  );
});
