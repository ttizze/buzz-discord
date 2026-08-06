import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Circle,
  Copy,
  LoaderCircle,
  Plus,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  cancelHostPairing,
  confirmHostPairingSas,
  listPairedComputers,
  startHostPairing,
  type PairedComputer,
} from "@/shared/api/tauriComputers";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

export const pairedComputersQueryKey = ["paired-computers"] as const;

type PairingStep =
  | "code"
  | "connecting"
  | "sas"
  | "finishing"
  | "done"
  | "error";

export function ComputersSettingsCard({
  currentPubkey,
}: {
  currentPubkey?: string;
}) {
  const queryClient = useQueryClient();
  const computersQuery = useQuery({
    enabled: Boolean(currentPubkey),
    queryKey: pairedComputersQueryKey,
    queryFn: listPairedComputers,
    refetchInterval: 15_000,
  });
  const relayQuery = useQuery({
    queryKey: ["active-relay-url"],
    queryFn: getRelayWsUrl,
    staleTime: 30_000,
  });
  const [open, setOpen] = React.useState(false);
  const [pairingCode, setPairingCode] = React.useState("");
  const [sas, setSas] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<PairingStep>("code");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    listen<{ sas: string }>("host-pairing-sas-received", (event) => {
      if (cancelled) return;
      setSas(event.payload.sas);
      setStep("sas");
    }).then((unlisten) =>
      cancelled ? unlisten() : unlisteners.push(unlisten),
    );
    listen<{ computer: PairedComputer }>("host-pairing-complete", () => {
      if (cancelled) return;
      setStep("done");
      void queryClient.invalidateQueries({ queryKey: pairedComputersQueryKey });
    }).then((unlisten) =>
      cancelled ? unlisten() : unlisteners.push(unlisten),
    );
    listen<{ message: string }>("host-pairing-error", (event) => {
      if (cancelled) return;
      setError(event.payload.message);
      setStep("error");
    }).then((unlisten) =>
      cancelled ? unlisten() : unlisteners.push(unlisten),
    );
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [queryClient]);

  function resetDialog() {
    setPairingCode("");
    setSas(null);
    setError(null);
    setStep("code");
  }

  async function beginPairing() {
    if (!pairingCode.trim()) return;
    setError(null);
    setStep("connecting");
    try {
      await startHostPairing(pairingCode.trim());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start pairing.",
      );
      setStep("error");
    }
  }

  async function confirmSas() {
    setStep("finishing");
    try {
      await confirmHostPairingSas();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not confirm pairing.",
      );
      setStep("error");
    }
  }

  function closeDialog() {
    if (!["code", "done", "error"].includes(step)) {
      void cancelHostPairing();
    }
    setOpen(false);
    resetDialog();
  }

  const installCommand = relayQuery.data
    ? `buzz-host pair --relay ${relayQuery.data}`
    : "buzz-host pair --relay wss://your-relay.example.com";

  return (
    <section className="min-w-0" data-testid="settings-computers">
      <SettingsSectionHeader
        title="Computers"
        description="Pair headless computers such as VPS instances, then select their folders when creating projects."
      />

      <SettingsOptionGroup>
        {(computersQuery.data ?? []).map((computer) => (
          <SettingsOptionRow
            data-testid={`paired-computer-${computer.computerId}`}
            key={computer.computerId}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60">
                <Server className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {computer.computerName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {computer.platform} · {computer.defaultPath}
                </p>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Circle
                className={
                  computer.online
                    ? "h-2.5 w-2.5 fill-emerald-500 text-emerald-500"
                    : "h-2.5 w-2.5 fill-muted-foreground/30 text-muted-foreground/30"
                }
              />
              {computer.online ? "Online" : "Offline"}
            </span>
          </SettingsOptionRow>
        ))}
        {computersQuery.data?.length === 0 ? (
          <SettingsOptionRow>
            <p className="text-sm text-muted-foreground">
              No headless computers paired yet.
            </p>
          </SettingsOptionRow>
        ) : null}
        <SettingsOptionRow>
          <div>
            <p className="text-sm font-medium">Add a computer</p>
            <p className="text-xs text-muted-foreground">
              Run Buzz Host over SSH; no VPS desktop or VNC is required.
            </p>
          </div>
          <Button
            data-testid="add-computer-button"
            disabled={!currentPubkey}
            onClick={() => {
              resetDialog();
              setOpen(true);
            }}
            size="sm"
            type="button"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add computer
          </Button>
        </SettingsOptionRow>
      </SettingsOptionGroup>

      <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent className="max-w-lg" data-testid="add-computer-dialog">
          <DialogHeader>
            <DialogTitle>Add a headless computer</DialogTitle>
            <DialogDescription>
              Run the command over SSH, then paste the one-time pairing code
              printed by the VPS.
            </DialogDescription>
          </DialogHeader>

          {step === "code" || step === "connecting" || step === "error" ? (
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <p className="text-sm font-medium">1. On the VPS</p>
                <div className="flex items-center gap-2 rounded-xl bg-muted/50 p-3">
                  <code className="min-w-0 flex-1 select-all break-all text-xs">
                    {installCommand}
                  </code>
                  <Button
                    aria-label="Copy VPS pairing command"
                    onClick={() =>
                      void writeTextToClipboard(installCommand).then(() =>
                        toast.success("Command copied"),
                      )
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="host-pairing-code"
                >
                  2. Paste the pairing code
                </label>
                <Textarea
                  className="min-h-28 font-mono text-xs"
                  data-testid="host-pairing-code"
                  disabled={step === "connecting"}
                  id="host-pairing-code"
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="nostrpair://…"
                  value={pairingCode}
                />
              </div>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button onClick={closeDialog} type="button" variant="outline">
                  Cancel
                </Button>
                <Button
                  data-testid="connect-host-pairing"
                  disabled={!pairingCode.trim() || step === "connecting"}
                  onClick={() => void beginPairing()}
                  type="button"
                >
                  {step === "connecting" ? (
                    <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : null}
                  Connect
                </Button>
              </div>
            </div>
          ) : step === "sas" && sas ? (
            <div className="space-y-5 pt-3 text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
              <div>
                <p className="text-sm font-medium">
                  Confirm this code matches the VPS
                </p>
                <p
                  className="mt-3 font-mono text-4xl font-bold tracking-[0.25em]"
                  data-testid="host-pairing-sas"
                >
                  {sas.slice(0, 3)} {sas.slice(3)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={closeDialog}
                  type="button"
                  variant="outline"
                >
                  <X className="mr-1.5 h-4 w-4" /> Cancel
                </Button>
                <Button
                  className="flex-1"
                  data-testid="confirm-host-sas"
                  onClick={() => void confirmSas()}
                  type="button"
                >
                  <Check className="mr-1.5 h-4 w-4" /> Codes match
                </Button>
              </div>
            </div>
          ) : step === "finishing" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Registering computer…
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                <Check className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium">Computer paired</p>
              <p className="text-xs text-muted-foreground">
                Start `buzz-host run` on the VPS. Its folders will appear in
                Project creation.
              </p>
              <Button className="mt-2" onClick={closeDialog} type="button">
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
