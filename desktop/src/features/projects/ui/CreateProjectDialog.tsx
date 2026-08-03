import * as React from "react";
import { FolderOpen, Laptop, Server } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import type { CreateProjectInput } from "@/features/projects/useCreateProject";
import {
  getComputerIdentity,
  listPairedComputers,
  pickProjectFolder,
  type PairedComputer,
  type ProjectFolderSelection,
} from "@/shared/api/tauriComputers";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { RemoteFolderBrowserDialog } from "./RemoteFolderBrowserDialog";

const CREATE_FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors duration-150 ease-out hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const CREATE_FIELD_CONTROL_CLASS =
  "border-0 bg-transparent text-muted-foreground/55 shadow-none outline-none ring-0 transition-colors duration-150 ease-out placeholder:text-muted-foreground/55 focus:bg-transparent focus:text-foreground focus:outline-hidden focus-visible:ring-0";
const CREATE_LABEL_OPTIONAL_CLASS =
  "ml-1 text-xs font-normal text-muted-foreground/50";

type CreateProjectDialogProps = {
  isCreating: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/** Creates a community project backed by a workspace on this computer. */
export function CreateProjectDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: CreateProjectDialogProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [folder, setFolder] = React.useState<ProjectFolderSelection | null>(
    null,
  );
  const [computerAccess, setComputerAccess] = React.useState<
    "personal" | "shared"
  >("shared");
  const [isPickingFolder, setIsPickingFolder] = React.useState(false);
  const [selectedComputerId, setSelectedComputerId] = React.useState("local");
  const [remoteBrowserOpen, setRemoteBrowserOpen] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const localComputerQuery = useQuery({
    queryKey: ["computer-identity"],
    queryFn: getComputerIdentity,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const computersQuery = useQuery({
    queryKey: ["paired-computers"],
    queryFn: listPairedComputers,
    staleTime: 15_000,
  });
  const selectedRemoteComputer =
    computersQuery.data?.find(
      (computer) => computer.computerId === selectedComputerId,
    ) ?? null;

  React.useEffect(() => {
    if (!open) return;

    setName("");
    setDescription("");
    setFolder(null);
    setComputerAccess("shared");
    setSelectedComputerId("local");
    setRemoteBrowserOpen(false);
    setErrorMessage(null);

    // Small delay to let the dialog animation start before focusing.
    const timerId = globalThis.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName || !folder) return;

    setErrorMessage(null);

    try {
      await onCreate({
        name: trimmedName,
        description: description.trim() || undefined,
        workspacePath: folder.path,
        computerId: folder.computerId,
        computerName: folder.computerName,
        computerAccess,
        gitRepository: folder.gitRepository,
      });

      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create project.",
      );
    }
  }

  async function handlePickFolder() {
    if (selectedRemoteComputer) {
      setRemoteBrowserOpen(true);
      return;
    }
    setIsPickingFolder(true);
    setErrorMessage(null);
    try {
      const selection = await pickProjectFolder();
      if (!selection) return;
      setFolder(selection);
      setName((current) => current.trim() || selection.name);
      globalThis.setTimeout(() => nameInputRef.current?.focus(), 0);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not select the folder.",
      );
    } finally {
      setIsPickingFolder(false);
    }
  }

  function selectComputer(computerId: string) {
    if (computerId === selectedComputerId) return;
    setSelectedComputerId(computerId);
    setFolder(null);
    setErrorMessage(null);
  }

  return (
    <>
      <Dialog
        onOpenChange={(nextOpen) => {
          if (!nextOpen && isCreating) return;
          onOpenChange(nextOpen);
        }}
        open={open}
      >
        <ChooserDialogContent
          className="max-w-lg"
          contentClassName="pt-3"
          data-testid="create-project-dialog"
          description="Choose a folder on this computer and make it available as a community workspace."
          footer={
            <div className="flex w-full items-center justify-end gap-3">
              <Button
                data-testid="create-project-submit"
                disabled={
                  isCreating ||
                  isPickingFolder ||
                  name.trim().length === 0 ||
                  !folder
                }
                form="create-project-form"
                type="submit"
              >
                {isCreating ? "Creating..." : "Create project"}
              </Button>
            </div>
          }
          footerClassName="border-t-0 pt-0"
          headerClassName="pb-2"
          title="Create a new project"
        >
          <form
            className="space-y-5"
            id="create-project-form"
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
          >
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                Computer
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  aria-pressed={selectedComputerId === "local"}
                  className={cn(
                    "rounded-xl border px-3 py-3 text-left transition-colors",
                    selectedComputerId === "local"
                      ? "border-primary bg-primary/10"
                      : "border-input bg-muted/30 hover:border-muted-foreground/40",
                  )}
                  data-testid="project-computer-local"
                  onClick={() => selectComputer("local")}
                  type="button"
                >
                  <Laptop className="mb-2 h-4 w-4 text-muted-foreground" />
                  <span className="block truncate text-sm font-medium">
                    {localComputerQuery.data?.computerName ?? "This computer"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Desktop
                  </span>
                </button>
                {(computersQuery.data ?? []).map((computer: PairedComputer) => (
                  <button
                    aria-pressed={selectedComputerId === computer.computerId}
                    className={cn(
                      "rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-50",
                      selectedComputerId === computer.computerId
                        ? "border-primary bg-primary/10"
                        : "border-input bg-muted/30 hover:border-muted-foreground/40",
                    )}
                    data-testid={`project-computer-${computer.computerId}`}
                    disabled={!computer.online}
                    key={computer.computerId}
                    onClick={() => selectComputer(computer.computerId)}
                    type="button"
                  >
                    <Server className="mb-2 h-4 w-4 text-muted-foreground" />
                    <span className="block truncate text-sm font-medium">
                      {computer.computerName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {computer.online ? "Online" : "Offline"}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                Project folder
              </span>
              <Button
                className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                data-testid="create-project-folder"
                disabled={isCreating || isPickingFolder}
                onClick={() => void handlePickFolder()}
                type="button"
                variant="outline"
              >
                <FolderOpen className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {folder
                      ? folder.name
                      : isPickingFolder
                        ? "Opening folder picker…"
                        : "Choose folder…"}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {folder
                      ? folder.path
                      : selectedRemoteComputer
                        ? "Browse folders on the paired computer."
                        : "Files, local changes, and Codex access come from this computer."}
                  </span>
                </span>
              </Button>
            </div>

            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="create-project-name"
              >
                Name
              </label>
              <div
                className={cn(
                  "flex min-h-11 items-center px-3",
                  CREATE_FIELD_SHELL_CLASS,
                )}
              >
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  className={cn(
                    "h-8 px-0 py-0 leading-6",
                    CREATE_FIELD_CONTROL_CLASS,
                  )}
                  data-testid="create-project-name"
                  disabled={isCreating}
                  id="create-project-name"
                  onChange={(event) => {
                    setName(event.target.value);
                    setErrorMessage(null);
                  }}
                  placeholder="bee-garden-game"
                  ref={nameInputRef}
                  spellCheck={false}
                  value={name}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="create-project-description"
              >
                Description
                <span className={CREATE_LABEL_OPTIONAL_CLASS}>Optional</span>
              </label>
              <div className={CREATE_FIELD_SHELL_CLASS}>
                <Textarea
                  className={cn(
                    "min-h-20 resize-none px-3 py-3 leading-5",
                    CREATE_FIELD_CONTROL_CLASS,
                  )}
                  data-testid="create-project-description"
                  disabled={isCreating}
                  id="create-project-description"
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setErrorMessage(null);
                  }}
                  placeholder="What this project is about"
                  rows={2}
                  value={description}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                Who can run Codex on this computer?
              </span>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    {
                      value: "shared",
                      label: "Shared computer",
                      detail: "Community members can start agents",
                      icon: Server,
                    },
                    {
                      value: "personal",
                      label: "My computer",
                      detail: "Only I can start agents",
                      icon: Laptop,
                    },
                  ] as const
                ).map((option) => {
                  const Icon = option.icon;
                  const selected = computerAccess === option.value;
                  return (
                    <button
                      aria-pressed={selected}
                      className={cn(
                        "rounded-xl border px-3 py-3 text-left transition-colors",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-input bg-muted/30 hover:border-muted-foreground/40",
                      )}
                      data-testid={`create-project-access-${option.value}`}
                      disabled={isCreating}
                      key={option.value}
                      onClick={() => setComputerAccess(option.value)}
                      type="button"
                    >
                      <Icon className="mb-2 h-4 w-4 text-muted-foreground" />
                      <span className="block text-sm font-medium">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
              {folder ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {folder.computerName} will host this workspace. Community
                  members can see its files and uncommitted changes.
                  {folder.gitRepository
                    ? " Git tools will also be available."
                    : " Git is not required."}
                </p>
              ) : null}
            </div>

            {errorMessage ? (
              <p className="text-sm text-destructive">{errorMessage}</p>
            ) : null}
          </form>
        </ChooserDialogContent>
      </Dialog>
      <RemoteFolderBrowserDialog
        computer={selectedRemoteComputer}
        onOpenChange={setRemoteBrowserOpen}
        onSelect={(selection) => {
          setFolder(selection);
          setName((current) => current.trim() || selection.name);
        }}
        open={remoteBrowserOpen}
      />
    </>
  );
}
