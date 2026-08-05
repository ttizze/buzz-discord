import { invoke } from "@tauri-apps/api/core";

export type ComputerIdentity = Readonly<{
  installationId: string;
  name: string;
}>;

type E2eComputer = ComputerIdentity & Readonly<{ selectedFolder: string }>;

declare global {
  interface Window {
    __BUZZCODE_E2E_COMPUTER__?: E2eComputer;
  }
}

export async function currentComputerIdentity(): Promise<ComputerIdentity> {
  const testComputer = window.__BUZZCODE_E2E_COMPUTER__;
  if (import.meta.env.MODE === "e2e") {
    const installationId =
      testComputer?.installationId ??
      window.localStorage.getItem("buzzcode.e2e-computer-id") ??
      `e2e-${crypto.randomUUID()}`;
    window.localStorage.setItem("buzzcode.e2e-computer-id", installationId);
    return {
      installationId,
      name: testComputer?.name ?? "E2E Computer",
    };
  }
  return invoke<ComputerIdentity>("computer_identity");
}

export async function chooseProjectFolder(): Promise<string | null> {
  const testComputer = window.__BUZZCODE_E2E_COMPUTER__;
  if (import.meta.env.MODE === "e2e") {
    return testComputer?.selectedFolder ?? "/tmp/buzzcode-e2e-project";
  }
  return invoke<string | null>("select_project_folder");
}
