import { invokeTauri } from "@/shared/api/tauri";

export type ProjectFolderSelection = {
  path: string;
  name: string;
  computerId: string;
  computerName: string;
  gitRepository: boolean;
};

export type ComputerIdentity = {
  computerId: string;
  computerName: string;
};

export type PairedComputer = {
  computerId: string;
  computerName: string;
  agentPubkey: string;
  platform: string;
  capabilities: string[];
  defaultPath: string;
  online: boolean;
};

export type HostDirectoryEntry = {
  name: string;
  path: string;
};

export type HostDirectoryListing = {
  path: string;
  name: string;
  parent: string | null;
  gitRepository: boolean;
  directories: HostDirectoryEntry[];
};

export function getComputerIdentity(): Promise<ComputerIdentity> {
  return invokeTauri<ComputerIdentity>("get_computer_identity");
}

/** Select a workspace folder hosted by this computer for a Buzz project. */
export function pickProjectFolder(): Promise<ProjectFolderSelection | null> {
  return invokeTauri<ProjectFolderSelection | null>("pick_project_folder");
}

/** Computers paired to the active identity on this community Relay. */
export function listPairedComputers(): Promise<PairedComputer[]> {
  return invokeTauri<PairedComputer[]>("list_paired_computers");
}

/** Accept a pairing code printed by `buzz-host pair` on a headless computer. */
export function startHostPairing(pairingCode: string): Promise<void> {
  return invokeTauri("start_host_pairing", { pairingCode });
}

export function confirmHostPairingSas(): Promise<void> {
  return invokeTauri("confirm_host_pairing_sas");
}

export function cancelHostPairing(): Promise<void> {
  return invokeTauri("cancel_host_pairing");
}

/** List a directory through the paired host's encrypted Relay RPC. */
export function listRemoteHostDirectory(
  agentPubkey: string,
  path: string,
): Promise<HostDirectoryListing> {
  return invokeTauri<HostDirectoryListing>("list_remote_host_directory", {
    agentPubkey,
    path,
  });
}
